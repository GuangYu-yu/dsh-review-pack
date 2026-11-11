#!/usr/bin/env node
// 一次跑完全部机械检查：交付物的内容、账本、锚点、目录残留、分路覆盖。
// 用法：
//   node review-check.mjs <产出目录> [--root <对象根>] [--lanes <lanes.json>] [--scope <范围清单>] [--json]
// 退出码：0 全部通过；1 有不通过项；2 用法或环境错误。
//
// 它不认报告的形状：没有段名、没有表也能过。内容项由 check-claims.mjs 判
// （未填槽位、替读者宣布通过、完整性命题三类），这里只管"该不该出现在这个目录里"
// 和"能不能对上源"。账本的形状也由主审定：只要有一张表、表头里有「位置」列。
import fs from 'node:fs';
import path from 'node:path';
import { scan as scanClaims } from './check-claims.mjs';
import { validateFile, parseLedger } from './ledger.mjs';
import { verify } from './verify-quotes.mjs';

const USAGE = `用法：node review-check.mjs <产出目录> [--root <对象根>] [--lanes <lanes.json>] [--scope <范围清单>] [--json]

产出目录里应当有一份交付物（报告或一段结论）；分过路或分过轮的评审，旁边还应当有一本合并后的账本，其余工作文件放在被审对象之外。
--root 给了就同时核每条「文件:行号」锚点（文件在不在、行号越没越界）。
--lanes 给了就核分路覆盖：对象根下每个匹配扩展名的文件，至少被一路点名；同时要求交付目录里有账本。
--scope 给了就核越界：报告与账本里的每个位置，要么在范围清单里，要么那一条自己标了「清单外」。它核的是标没标，核不了读了多少。分过路（--lanes）时必须给。`;

// 账本：表头里有一列叫「位置」，正文基本就是这张表。不认列名、不认列数、不认顺序——
// 曾经用一张固定列名的正则认账本，结果自由表头的账本被当成了第二份交付物。
const LEDGER_COLUMN = /\|\s*位置\s*\|/;
function looksLikeLedger(name, text) {
  if (!LEDGER_COLUMN.test(text)) return false;
  if (/ledger|账本/i.test(name)) return true;
  let table = 0;
  let prose = 0;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith('>')) continue;
    if (t.startsWith('|')) table += 1;
    else prose += 1;
  }
  // 账本整篇就是表（加表头与注解）；报告总有几行成文的句子。一条正文都没有才算账本——
  // 放宽到"几行以内"时，一张只有表格的报告会被判成账本，于是"两份账本、没有交付物"。
  return table >= 2 && prose === 0;
}
const SKIP_DIRS = ['.git', 'node_modules', 'target', 'dist', '.release', 'vendor', '.next'];

// 范围清单：对象根下该看的文件一行一个，后面写"读了／未读／跳过（理由）"。
// 只认每行第一个像路径的词，其余一律不管——它是工作文件，形状不该被脚本规定。
// 这一节核的是"标没标"，不是"读了多少"：后者机械判不了，别在这里假装。
const SCOPE_LABEL = /清单外|范围外|越界|未列入|不在清单/;
const POS_RE = /[A-Za-z0-9_./\\:-]*\.[A-Za-z0-9]+:\d+/g;
function parseScope(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    let t = raw.trim();
    if (!t || /^[#>|]/.test(t)) continue;
    t = t.replace(/^[-*+]\s+/, '').replace(/`/g, '');
    const m = t.match(/^([^\s（(),]+)/);
    if (!m) continue;
    const p = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
    if (!/\//.test(p) && !/\.[A-Za-z0-9]+$/.test(p)) continue;
    if (/^\d+\.\d+/.test(p)) continue;
    out.push(p);
  }
  return out;
}
function scopeMatch(pos, entries) {
  const p = pos.replace(/\\/g, '/').replace(/^\.\//, '');
  let best = null;
  for (const e of entries) {
    if (p === e || p.endsWith('/' + e) || e.endsWith('/' + p)) {
      if (!best || e.length > best.length) best = e;
    }
  }
  // 不按文件名兜底：两份同名文件（src/cmd/plan.rs 与 src/movepart/plan.rs）会被认成同一份，
  // 于是越界的条目看着像在清单里。认不出就当清单外——宁可让作者把路径写全。
  return best ? { how: 'path', entry: best } : null;
}
// 一个位置算不算"标了"，按它所在的那一块看：一段（空行隔开）、一个标题下、或表的一行。
// 表不能整张算一块，否则表里任意一处写了"清单外"，全表都被兜住。
function positionsWithBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blockOf = (i) => {
    if (lines[i].trim().startsWith('|')) return lines[i];
    let a = i;
    let b = i;
    while (a > 0 && lines[a - 1].trim() !== '' && !lines[a - 1].trim().startsWith('#')) a--;
    while (b + 1 < lines.length && lines[b + 1].trim() !== '' && !lines[b + 1].trim().startsWith('#')) b++;
    return lines.slice(a, b + 1).join('\n');
  };
  const found = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(POS_RE)) {
      if (m[0].includes('://')) continue;
      found.push({ pos: m[0], block: blockOf(i), line: i + 1 });
    }
  });
  return found;
}

export function runCheck({ dir, root = null, lanesFile = null, scopeFile = null }) {
  const problems = [];
  const notes = [];
  const fail = (msg) => problems.push(msg);

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ok: false, problems: [`产出目录不存在：${dir}`], notes };
  }

  // 1. 目录里有什么：账本另算，其余 .md 都是候选交付物
  const md = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort();
  const deliverables = [];
  let ledgerFile = null;
  for (const name of md) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const isLedger = looksLikeLedger(name, text);
    if (isLedger) {
      if (/ledger-L\d+/i.test(name)) fail(`${name}：这是分路账本，回收时应当已经合并并删掉`);
      else if (ledgerFile) fail(`有两份账本：${ledgerFile}、${name}——合并后只留一份`);
      else ledgerFile = name;
    } else {
      deliverables.push(name);
    }
  }
  const reportFile = deliverables[0] || null;
  if (deliverables.length === 0) fail('目录里没有交付物——报告、一段结论、一张清单都算，工作文件不算');
  else if (deliverables.length > 1) fail(`有两份交付物：${deliverables.join('、')}——对外只交一份，其余放被审对象之外`);
  if (!ledgerFile) {
    if (lanesFile) fail('分过路却没有账本：交付目录里应当是报告 + 一本合并后的账本');
    else notes.push('目录里没有账本——只有没分过路的轻量评审可以这样');
  }

  // 2. 交付物的内容（不认形状）
  if (reportFile) {
    const p = path.join(dir, reportFile);
    for (const item of scanClaims(fs.readFileSync(p, 'utf8'))) fail(`交付物 ${reportFile} ${item}`);
  }

  // 3. 账本
  if (ledgerFile) {
    const p = path.join(dir, ledgerFile);
    const text = fs.readFileSync(p, 'utf8');
    const v = validateFile(text, ledgerFile);
    const list = v.problems || (Array.isArray(v) ? v : []);
    for (const item of list) fail(`账本 ${typeof item === 'string' ? item : item.msg || JSON.stringify(item)}`);
    notes.push(`账本 ${ledgerFile}：${(v.rows || []).length} 条`);

    // 根节：报告第 2 项的唯一来源。条目够多却一条根都不写，说明分组那一环没做。
    if ((v.rows || []).length >= 5) {
      const { sections } = parseLedger(text, ledgerFile);
      // 一条都并不起来时，结论写在节标题上（`# 根：无可合并，N 条独立`）——账本的每一行都必须带「文件:行号」，
      // 所以"没有根"这件事没有行可以承载，只能落在标题里。
      const roots = (sections || []).filter(
        (s) => /根|合并|独立/.test(s.title || '') && (s.rows.length > 0 || /可合并|独立/.test(s.title || '')),
      );
      if (roots.length === 0) {
        fail(`账本 ${ledgerFile} 没有「根」这一节（${v.rows.length} 条发现）：报告第 2 项会没有来源——一行一个根，写改哪一处、挂着哪几条、什么会推翻它；一条都并不起来就把结论写在节标题上（「# 根：无可合并，N 条独立」）`);
      } else {
        const total = roots.reduce((n, s) => n + s.rows.length, 0);
        notes.push(total === 0 ? `根：无可合并（${roots.map((s) => s.title).join('、')}）` : `根 ${total} 条（${roots.map((s) => s.title).join('、')}）`);
      }
    }
  }

  // 4. 锚点
  if (reportFile && root) {
    const p = path.join(dir, reportFile);
    const q = verify(fs.readFileSync(p, 'utf8'), { file: reportFile, root: path.resolve(root) });
    if (q.anchorsChecked === 0) notes.push('锚点 0 处：交付物里没有任何 `文件:行号`，这一项没有可核的');
    for (const item of q.problems) fail(`锚点 ${item.msg || item.code}`);
    notes.push(`锚点 ${q.anchorsChecked} 处 · 引文 ${q.quotesChecked} 条 · 提示 ${q.advisories.length} 项`);
  }

  // 4b. 第 2 项：发现了若干条，却没写"哪些条共用一个改动"（或没写它们互相独立）
  if (reportFile) {
    const text = fs.readFileSync(path.join(dir, reportFile), 'utf8');
    const anchors = (text.match(/[A-Za-z0-9_./\\:-]*\.[A-Za-z0-9]+:\d+/g) || []).length;
    const declared = /根因|共同根|可合并|互相独立|各自独立|彼此独立|只有散条|综合没做/.test(text);
    if (anchors >= 4 && !declared) {
      fail(`交付物 ${reportFile} 有 ${anchors} 处位置，却没有"哪些条会被同一个改动一起消掉"的结论，也没写"互相独立"——第 2 项空着要写成结论，沉默读者分不清是判过还是没走到`);
    }
  }

  // 4c. 越界：位置要么在范围清单里，要么那一条自己标了清单外
  if (scopeFile) {
    let entries = null;
    try {
      entries = parseScope(fs.readFileSync(scopeFile, 'utf8'));
    } catch (e) {
      return { ok: false, problems: [`读不了范围清单 ${scopeFile}：${e.message}`], notes };
    }
    if (entries.length === 0) {
      fail(`范围清单 ${scopeFile} 里一个路径都没认出来——一行一个文件路径，后面写"读了／未读／跳过（理由）"`);
    } else {
      const targets = [];
      if (reportFile) targets.push([reportFile, fs.readFileSync(path.join(dir, reportFile), 'utf8')]);
      if (ledgerFile) targets.push([ledgerFile, fs.readFileSync(path.join(dir, ledgerFile), 'utf8')]);
      const seen = new Set();
      const unlabeled = [];
      let inside = 0;
      let labeled = 0;
      for (const [, text] of targets) {
        for (const { pos, block } of positionsWithBlocks(text)) {
          if (seen.has(pos)) continue;
          seen.add(pos);
          const hit = scopeMatch(pos.replace(/:\d+$/, ''), entries);
          if (hit) {
            inside += 1;
            continue;
          }
          if (SCOPE_LABEL.test(block)) labeled += 1;
          else unlabeled.push(pos);
        }
      }
      if (unlabeled.length) {
        const shown = unlabeled.slice(0, 5).join('、');
        fail(`${unlabeled.length} 处位置不在范围清单里，那一条也没标"清单外"：${shown}${unlabeled.length > 5 ? ' 等' : ''}——要么把它加进清单并说明原计划为什么没含它，要么在那一块里写明读到了什么程度、纳入范围与否交给读者定`);
      }
      notes.push(`范围清单 ${entries.length} 个文件 · 位置在清单内 ${inside} 处 · 清单外且已标 ${labeled} 处`);
    }
  } else if (lanesFile) {
    fail('分过路却没给 --scope <范围清单>：越界这一项没法事后补——过程里要有一份"对象根下该看的文件一行一个"，报告与账本里的位置都按它核');
  }

  // 5. 分路覆盖
  if (lanesFile) {
    if (!root) {
      fail('给了 --lanes 就必须同时给 --root：覆盖是按对象根算的');
    } else {
      let manifest = null;
      try {
        manifest = JSON.parse(fs.readFileSync(lanesFile, 'utf8'));
      } catch (e) {
        return { ok: false, problems: [`读不了分路清单 ${lanesFile}：${e.message}`], notes };
      }
      const exts = (manifest.extensions || ['.rs']).map((e) => e.toLowerCase());
      const claimed = new Set();
      for (const lane of manifest.lanes || []) {
        for (const f of lane.files || []) claimed.add(path.resolve(root, f));
        if (!lane.ledger) fail(`分路 ${lane.name || '?'} 没写账本路径`);
      }
      const walk = (d, out) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            if (SKIP_DIRS.includes(e.name)) continue;
            walk(p, out);
          } else if (exts.includes(path.extname(e.name).toLowerCase())) out.push(p);
        }
      };
      const all = [];
      walk(path.resolve(root), all);
      const uncovered = all.filter((f) => !claimed.has(f));
      if (uncovered.length) {
        const shown = uncovered.slice(0, 5).map((f) => path.relative(root, f)).join('、');
        fail(`有 ${uncovered.length} 个文件没有任何一路主责：${shown}${uncovered.length > 5 ? ' 等' : ''}`);
      }
      notes.push(`分路 ${(manifest.lanes || []).length} 路 · 对象 ${all.length} 个文件 · 有主责 ${all.length - uncovered.length} 个`);
    }
  }

  return { ok: problems.length === 0, report: reportFile, ledger: ledgerFile, problems, notes };
}

function main(argv) {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  let dir = null;
  let root = null;
  let lanesFile = null;
  let scopeFile = null;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') root = argv[++i];
    else if (a === '--lanes') lanesFile = argv[++i];
    else if (a === '--scope') scopeFile = argv[++i];
    else if (a === '--json') asJson = true;
    else if (!dir) dir = a;
    else {
      console.error(`不认识的参数：${a}`);
      return 2;
    }
  }
  if (!dir) {
    console.error(USAGE);
    return 2;
  }
  const r = runCheck({ dir, root, lanesFile, scopeFile });
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const n of r.notes) console.log(`说明 ${n}`);
    if (r.ok) console.log(`\n全部通过：${r.report}${r.ledger ? '＋' + r.ledger : ''}`);
    else {
      console.log(`\n不通过 ${r.problems.length} 项：`);
      for (const p of r.problems) console.log(`- ${p}`);
    }
  }
  return r.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('review-check.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
