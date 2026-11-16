#!/usr/bin/env node
// 核执行档案（run-record.md）的形状。它不判结论对错，也不判档案真假——
// 它判的是：这份档案有没有把「当时跑没跑」写成能被第二个人对上的形状。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(HERE, '..');              // …/skills/review
const RECORD = 'run-record.md';

const SECTIONS = ['加载', '仪器', '编制', '自评', '缺口'];
const USAGE = [
  '用法：node scripts/run-record-check.mjs <交付目录>',
  '',
  '它核五节在不在、加载的册能不能逐个对上、仪器有没有命令行与退出码、',
  '未跑有没有写原因、自评的 M 是不是大于 N、缺口有没有写成「未取得 → 因此不能确认」。',
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
  const dir = process.argv[2];
  if (!dir) { console.log(USAGE); process.exit(2); }
  const r = checkRecord(dir);
  if (r.ok) console.log('run-record: OK（五节齐，形状可核）');
  else { console.log('run-record: FAIL'); for (const p of r.problems) console.log('  - ' + p); }
  process.exit(r.ok ? 0 : 1);
}
