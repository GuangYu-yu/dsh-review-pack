#!/usr/bin/env node
// 一次跑完全部机械检查：交付物的内容、账本、锚点、目录残留、分路覆盖。
// 用法：
//   node review-check.mjs <产出目录> [--root <对象根>] [--lanes <lanes.json>] [--json]
// 退出码：0 全部通过；1 有不通过项；2 用法或环境错误。
//
// 它不认报告的形状：没有段名、没有表也能过。内容项由 check-claims.mjs 判
// （未填槽位、替读者宣布通过、完整性命题三类），这里只管"该不该出现在这个目录里"
// 和"能不能对上源"。账本的形状也由主审定：只要有一张表、表头里有「位置」列。
import fs from 'node:fs';
import path from 'node:path';
import { scan as scanClaims } from './check-claims.mjs';
import { validateFile } from './ledger.mjs';
import { verify } from './verify-quotes.mjs';

const USAGE = `用法：node review-check.mjs <产出目录> [--root <对象根>] [--lanes <lanes.json>] [--json]

产出目录里应当有一份交付物（报告或一段结论）；分过路或分过轮的评审，旁边还应当有一本合并后的账本，其余工作文件放在被审对象之外。
--root 给了就同时核每条「文件:行号」锚点（文件在不在、行号越没越界）。
--lanes 给了就核分路覆盖：对象根下每个匹配扩展名的文件，至少被一路点名；同时要求交付目录里有账本。`;

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

export function runCheck({ dir, root = null, lanesFile = null }) {
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
    const v = validateFile(fs.readFileSync(p, 'utf8'), ledgerFile);
    const list = v.problems || (Array.isArray(v) ? v : []);
    for (const item of list) fail(`账本 ${typeof item === 'string' ? item : item.msg || JSON.stringify(item)}`);
    notes.push(`账本 ${ledgerFile}：${(v.rows || []).length} 条`);
  }

  // 4. 锚点
  if (reportFile && root) {
    const p = path.join(dir, reportFile);
    const q = verify(fs.readFileSync(p, 'utf8'), { file: reportFile, root: path.resolve(root) });
    if (q.anchorsChecked === 0) notes.push('锚点 0 处：交付物里没有任何 `文件:行号`，这一项没有可核的');
    for (const item of q.problems) fail(`锚点 ${item.msg || item.code}`);
    notes.push(`锚点 ${q.anchorsChecked} 处 · 引文 ${q.quotesChecked} 条 · 提示 ${q.advisories.length} 项`);
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
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') root = argv[++i];
    else if (a === '--lanes') lanesFile = argv[++i];
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
  const r = runCheck({ dir, root, lanesFile });
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
