#!/usr/bin/env node
// 一次跑完全部机械检查：交付物的形状、账本、锚点、目录残留、分路覆盖。
// 用法：
//   node review-check.mjs <产出目录> [--root <对象根>] [--lanes <lanes.json>] [--json]
// 退出码：0 全部通过；1 有不通过项；2 用法或环境错误。
import fs from 'node:fs';
import path from 'node:path';
import { scanText } from './verify-report.mjs';
import { validateFile } from './ledger.mjs';
import { verify } from './verify-quotes.mjs';

const USAGE = `用法：node review-check.mjs <产出目录> [--root <对象根>] [--lanes <lanes.json>] [--json]

产出目录里应当只有两样东西：一份报告、一份账本（没分过轮的评审可以只有报告）。
--root 给了就同时核每条「文件:行号」锚点（文件在不在、行号越没越界）。
--lanes 给了就核分路覆盖：对象根下每个匹配扩展名的文件，至少被一路点名。`;

const LEDGER_HEADER =
  /\|\s*#\s*\|\s*级别\s*\|\s*依据\s*\|[^\n]*\|[^\n]*修法[^\n]*\|[^\n]*反方[^\n]*\|[^\n]*撤回条件/;
const SKIP_DIRS = ['.git', 'node_modules', 'target', 'dist', '.release', 'vendor', '.next'];

export function runCheck({ dir, root = null, lanesFile = null }) {
  const problems = [];
  const notes = [];
  const fail = (msg) => problems.push(msg);

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ok: false, problems: [`产出目录不存在：${dir}`], notes };
  }

  // 1. 目录里有什么
  const md = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort();
  let reportFile = null;
  let ledgerFile = null;
  for (const name of md) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const isReport = /^#\s*评审报告/m.test(text);
    const isLedger = LEDGER_HEADER.test(text);
    if (isReport && isLedger) {
      fail(`${name}：既是报告又是账本，不能当一份用`);
    } else if (isReport) {
      if (reportFile) fail(`有两份报告：${reportFile}、${name}——对外只交一份`);
      else reportFile = name;
    } else if (isLedger) {
      if (/ledger-L\d+/i.test(name)) fail(`${name}：这是分路账本，回收时应当已经合并并删掉`);
      else if (ledgerFile) fail(`有两份账本：${ledgerFile}、${name}——合并后只留一份`);
      else ledgerFile = name;
    } else {
      fail(`${name}：认不出是报告还是账本；产出目录里不该放别的东西`);
    }
  }
  if (!reportFile) fail('目录里没有报告（报告一级标题是 `# 评审报告 · <对象名>`）');
  if (!ledgerFile) notes.push('目录里没有账本（只读一遍、没分轮的评审本来就没有账本）');

  // 2. 报告形状
  if (reportFile) {
    const p = path.join(dir, reportFile);
    const r = scanText(p, fs.readFileSync(p, 'utf8'));
    for (const item of r.problems) fail(`报告 ${item}`);
    for (const n of r.notes || []) notes.push(`报告 ${n}`);
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
    if (q.anchorsChecked === 0) notes.push('锚点 0 处：报告里没有任何 `文件:行号`，这一项没有可核的');
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
