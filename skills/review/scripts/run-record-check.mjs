#!/usr/bin/env node
// 核执行档案（run-record.md）的形状。它不判结论对错，也不判档案真假——
// 它判的是：这份档案有没有把「当时跑没跑」写成能被第二个人对上的形状。
//
// 仪器那一节多核一件事：档案里说跑过的脚本，得在 run-log.jsonl 里有对应的一行。
// 日志是脚本自己写的，档案是手写的——对不上，说明这一行不是那次调用留下的。
// 它仍核不了「日志是不是整份伪造的」：那要宿主层管（见 .debug-session/LIMITS.md 的 L3）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installRunLog, readRunLog, verifyChain } from './run-log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(HERE, '..');              // …/skills/review
const RECORD = 'run-record.md';

const SECTIONS = ['加载', '仪器', '编制', '自评', '缺口'];
// 会自己写日志的那几个脚本：仪器行点到它们，才要求日志里有对应的一行。
const LOGGED = ['check-claims.mjs', 'dispatch.mjs', 'ledger.mjs', 'review-check.mjs',
  'router-check.mjs', 'run-record-check.mjs', 'semantic-diff.mjs', 'verify-quotes.mjs'];
const USAGE = [
  '用法：node scripts/run-record-check.mjs <交付目录>',
  '',
  '它核五节在不在、加载的册能不能逐个对上、仪器有没有命令行与退出码、',
  '未跑有没有写原因、自评的 M 是不是大于 N、缺口有没有写成「未取得 → 因此不能确认」。',
  '仪器行点到本技能自己的脚本时，还要在 <交付目录>/run-log.jsonl（或 $REVIEW_RUN_LOG）里',
  '找到对应的一行，且那份日志的哈希链是完整的。',
  '它核不了「报告里说的和档案里写的是同一件事」——那要人对着读。',
].join('\n');

function sections(text) {
  const out = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  return out;
}

function bullets(lines) {
  return lines.map((s) => s.trim()).filter((s) => /^[-*]\s+/.test(s)).map((s) => s.replace(/^[-*]\s+/, ''));
}

export function checkRecord(dir) {
  const problems = [];
  const file = path.join(dir, RECORD);
  if (!fs.existsSync(file)) {
    return { ok: false, problems: ['缺 ' + RECORD + '：过程只留在对话里，读者无法判断当时跑没跑'], has: {} };
  }
  const sec = sections(fs.readFileSync(file, 'utf8'));
  const names = Object.keys(sec);
  const got = {};
  for (const want of SECTIONS) {
    const hit = names.find((n) => n.startsWith(want));
    if (!hit) problems.push('缺一节：' + want);
    else got[want] = sec[hit];
  }

  if (got['加载']) {
    const items = bullets(got['加载']);
    if (!items.length) problems.push('加载节是空的：一份分册都没列，说明这份报告不是按本技能出的');
    for (const it of items) {
      const p = it.match(/references\/[^\s`]+/);
      if (!p) { problems.push('加载节有一行看不出是哪一册：' + it); continue; }
      if (!fs.existsSync(path.join(SKILL_ROOT, p[0]))) problems.push('加载节列了不存在的分册：' + p[0]);
    }
    const joined = items.join('\n');
    for (const must of ['contract.md', 'format.md']) {
      if (!joined.includes(must)) problems.push('加载节没列 ' + must + '：入口写的是每次都读，没列就是没读');
    }
  }

  if (got['仪器']) {
    const items = bullets(got['仪器']);
    if (!items.length) problems.push('仪器节是空的：没跑写「未跑：〈原因〉」，不能留白');
    for (const it of items) {
      const skipped = it.match(/未跑\s*[:：]\s*(.*)$/);
      if (skipped) {
        if (skipped[1].trim().length < 8) problems.push('未跑却没写原因（不足一句）：' + it);
        continue;
      }
      if (!/\.mjs|\bnode\b/.test(it)) problems.push('仪器节这一行没有命令行：' + it);
      if (!/(?:exit|退出码)\s*[:：=]?\s*\d+/i.test(it)) problems.push('仪器节这一行没有退出码（写成 exit: 0）：' + it);
      // 声称跑过的那一行，它点到的文件得在盘上——删掉被核的对象，档案不能照样自证
      const files = it.match(/[\w一-龥./-]+\.(?:md|json|txt|mjs|ya?ml)/g) || [];
      for (const f of files) {
        const cands = [path.resolve(dir, f), path.resolve(f), path.resolve(SKILL_ROOT, f), path.resolve(SKILL_ROOT, 'scripts', path.basename(f))];
        if (!cands.some((p) => fs.existsSync(p))) problems.push('仪器行点到的文件不存在（删掉它，这一行就没有证据）：' + f);
      }
    }

    // 日志对账：脚本自己写的那一行，手写的档案对不上它就是事后补的。
    const claimed = [];
    for (const it of items) {
      if (/未跑\s*[:：]/.test(it)) continue;
      const script = LOGGED.find((n) => it.includes(n));
      if (!script) continue;
      if (/未记日志\s*[:：]\s*\S/.test(it)) continue;
      const ex = it.match(/(?:exit|退出码)\s*[:：=]?\s*(\d+)/i);
      claimed.push({ script, exit: ex ? Number(ex[1]) : null, line: it });
    }
    if (claimed.length) {
      // 只看这两个位置：显式设了的 $REVIEW_RUN_LOG，和交付目录里那份。不猜 cwd——
      // 猜错会把上一轮评审的日志当成这一轮的证据。
      const logFile = [process.env.REVIEW_RUN_LOG, path.join(dir, 'run-log.jsonl')].find((p) => p && fs.existsSync(p)) || null;
      const lines = logFile ? readRunLog(logFile) : null;
      if (lines === null) {
        for (const c of claimed) {
          problems.push('仪器节说跑了 ' + c.script + '，却没找到 run-log（评审开始时设 REVIEW_RUN_LOG=<交付目录>/run-log.jsonl）；'
            + '这一轮确实没留日志，就在这一行写「未记日志：〈原因〉」');
        }
      } else {
        for (const b of verifyChain(lines)) problems.push('日志 ' + path.basename(logFile) + ' 第 ' + b.at + ' 行：' + b.why);
        const rows = lines.map((raw) => { try { return JSON.parse(raw); } catch { return null; } });
        const used = new Set();
        for (const c of claimed) {
          const hit = rows.findIndex((r, i) => r && !used.has(i) && r.script === c.script && (c.exit === null || r.exit === c.exit));
          if (hit < 0) {
            problems.push('仪器节说跑了 ' + c.script + (c.exit === null ? '' : '（exit: ' + c.exit + '）')
              + '，日志里没有对应的一行——跳过没跑的话，这一行是事后补的');
          } else {
            used.add(hit);
            // 命令行原文也要对得上：档案里手写的参数，得真出现在那一次调用的 argv 里。
            // 只比脚本名与退出码的话，写一份"跑过 check-claims 但参数完全不同"的档案照样过。
            const argvText = (rows[hit] && rows[hit].argv ? rows[hit].argv : []).join(' ');
            const tokens = (c.line.match(/[\w一-龥./-]+\.(?:md|json|txt|mjs|ya?ml)/g) || [])
              .filter((t) => !t.includes(c.script));
            const missing = tokens.filter((t) => !argvText.includes(t) && !argvText.includes(path.basename(t)));
            if (missing.length) {
              problems.push('仪器行写的参数在日志里找不到：' + missing.join('、')
                + '（日志里那一次是 ' + (argvText || '（无参数）') + '）——命令行原文要与真跑的那次一致');
            }
          }
        }
      }
    }
  }

  if (got['编制']) {
    const text = got['编制'].join('\n');
    if (!/证据档位\s*[:：]\s*(实测|静态|未证)/.test(text)) problems.push('编制节没有写证据档位（实测／静态／未证）');
  }

  if (got['自评']) {
    const text = got['自评'].join('\n');
    const m = text.match(/(\d+)\s*\/\s*(\d+)/) || text.match(/共\s*(\d+)\s*条[^\d]*(\d+)\s*条/);
    if (!m) problems.push('自评节没有「M / N」这样的两个数');
    else {
      const [n, total] = [Number(m[1]), Number(m[2])];
      if (n > total) problems.push('自评 ' + n + ' / ' + total + '：可复核数大于结论总数');
      if (total < 1) problems.push('自评总数是 0：一份没有结论的评审不需要报告');
    }
  }

  if (got['缺口']) {
    const items = bullets(got['缺口']);
    if (!items.length) problems.push('缺口节是空的：没有缺口写「无」并说明凭什么，不能留白');
    for (const it of items) {
      if (it.startsWith('无')) {
        if (it.replace(/^无[:：，。；;]?/, '').trim().length < 8) problems.push('缺口写成「无」却没说明凭什么（例子：对象只有三个文件且逐个读过）：' + it);
        continue;
      }
      if (!/未取得|已取得/.test(it)) problems.push('缺口这一行没说清缺的是哪样材料（写成「未取得：…」）：' + it);
      if (!/因此不能确认/.test(it)) problems.push('缺口这一行没写它挡住了哪一句结论（写成「→ 因此不能确认：…」）：' + it);
    }
  }

  return { ok: problems.length === 0, problems, has: got };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  installRunLog('run-record-check.mjs');
  const dir = process.argv[2];
  if (!dir) { console.log(USAGE); process.exit(2); }
  const r = checkRecord(dir);
  if (r.ok) console.log('run-record: OK（五节齐，形状可核）');
  else { console.log('run-record: FAIL'); for (const p of r.problems) console.log('  - ' + p); }
  process.exit(r.ok ? 0 : 1);
}
