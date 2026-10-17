#!/usr/bin/env node
// 报告外形校验：只查**结构、算术、用词、可达性**。
//
// 用法：node verify-report.mjs <报告.md> [<报告.md> ...]
// 退出码：0 全部通过；1 有不通过项；2 用法错误。
//
// **它不判断一条发现对不对**，也不读被审对象。一旦开始判断内容，它就会误判，
// 而一个会误判的闸门比没有闸门更坏——跑两次失败之后，人就不跑了。
// 这里只认那些能机械判真假的事：块的顺序、两张表同号同条数、用量行自己报的数、
// 账本行的减法、依据与级别的用词、标「严重」有没有独立依据。
//
// 输出是给人看的：每条不通过都带行号与期望值，改完再跑一次。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LEVELS = ['严重', '一般', '待查'];
const EVIDENCE = ['跑了命令', '引了原文', '读源码', '推断'];
const CONFIDENCE = ['可证', '一环未读全', '存疑'];
const FORMS = ['收口', '默认值', '根'];
const SECTION_NAMES = ['发现的问题', '决策点', '停止审查的依据'];

const A_HEAD = ['#', '级别', '依据', '位置', '问题', '修复方向'];
const B_HEAD = ['#', '最强反方 → 是否成立', '撤回条件', '刻意没查'];
const C_HEAD = ['#', '形态', '现状或位置', '倾向', '挂住的条目'];
const D_HEAD = ['分册', '表态', '判据'];
const COVER_HEAD = ['范围', '读法', '理由'];

const norm = (s) => s.replace(/\r\n?/g, '\n');

/** 把围栏代码块的内容遮掉：结构检查不该被代码里的表格、尖括号、井号干扰。 */
function maskFences(lines) {
  const out = [];
  let fence = null;
  for (const raw of lines) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(raw);
    if (m !== null) {
      if (fence === null) { fence = m[1][0]; out.push(''); continue; }
      if (m[1][0] === fence) { fence = null; out.push(''); continue; }
    }
    out.push(fence === null ? raw : '');
  }
  return out;
}

const splitRow = (line) => {
  const t = line.trim();
  const body = t.startsWith('|') ? t.slice(1) : t;
  const cells = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '' || !body.endsWith('|')) cells.push(cur.trim());
  return cells;
};

const isSeparator = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');

function tableAt(vis, start) {
  if (start + 1 >= vis.length || !isSeparator(vis[start + 1])) return null;
  const header = splitRow(vis[start]);
  const rows = [];
  let i = start + 2;
  while (i < vis.length && vis[i].trimStart().startsWith('|')) {
    rows.push({ line: i + 1, cells: splitRow(vis[i]) });
    i++;
  }
  return { header, rows, start: start + 1, end: i };
}

/** 校验一份报告的正文，返回 { problems, notes }。不读被审对象，只认结构。 */
export function scanText(reportPath, text) {
  const problems = [];
  const notes = [];
  const lines = norm(text).split('\n');
  const vis = maskFences(lines);
  const at = (n) => `${reportPath}:${n}`;
  const fail = (n, msg) => problems.push(n === null ? msg : `${at(n)} ${msg}`);

  // ---- 标题与块序 ----
  const heads = [];
  for (let i = 0; i < vis.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(vis[i]);
    if (m !== null) heads.push({ line: i + 1, level: m[1].length, text: m[2].trim() });
  }
  const h1 = heads.filter((h) => h.level === 1);
  if (h1.length === 0) fail(null, '缺一级标题（`# 评审报告 · <对象名>`）');
  else if (h1.length > 1) fail(h1[1].line, `一级标题只能有一个，这里出现了 ${h1.length} 个`);
  else if (!/^评审报告/.test(h1[0].text)) fail(h1[0].line, '一级标题应以「评审报告」开头');

  const h2 = heads.filter((h) => h.level === 2);
  if (h2.length !== SECTION_NAMES.length) {
    fail(h2.length > 0 ? h2[0].line : null, `二级标题应恰好 ${SECTION_NAMES.length} 个（${SECTION_NAMES.map((s) => `## ${s}`).join('、')}），实际 ${h2.length} 个`);
  }
  for (let i = 0; i < Math.min(h2.length, SECTION_NAMES.length); i++) {
    if (h2[i].text !== SECTION_NAMES[i]) fail(h2[i].line, `第 ${i + 1} 个二级标题应为「${SECTION_NAMES[i]}」，实际「${h2[i].text}」——段名一个字都不改`);
  }
  const deep = heads.filter((h) => h.level >= 3);
  for (const h of deep) fail(h.line, `不许有 ${'#'.repeat(h.level)} 标题（「${h.text}」）——三张表与展开都不立标题`);

  // ---- 提要 ----
  const firstH2 = h2.length > 0 ? h2[0].line - 1 : vis.length;
  const quote = [];
  for (let i = 0; i < firstH2; i++) if (/^\s*>/.test(vis[i])) quote.push({ line: i + 1, text: vis[i] });
  if (quote.length !== 2) fail(quote.length > 0 ? quote[0].line : null, `提要应是引用块里的两行（结论、范围／未查），实际 ${quote.length} 行`);
  else {
    if (!quote[1].text.includes('范围')) fail(quote[1].line, '提要第二行缺「范围」');
    if (!quote[1].text.includes('未查')) fail(quote[1].line, '提要第二行缺「未查」——"未查"写在这里，不是文末');
    // 第一行写的是**对象的状态**，不是合并许可。合并只是审查的一种用途。
    const head = quote[0].text.replace(/^\s*>\s*/, '');
    const stateRe = /^\*\*(先修|可以先用|先验证)\*\*\s*——\s*\S/;
    if (/能合|不能合|可合|不可合/.test(head)) {
      fail(quote[0].line, '提要第一行写的是对象状态（`先修`／`可以先用`／`先验证`），不是合并许可——审的是这份东西，不是审批流程');
    } else if (!stateRe.test(head)) {
      fail(quote[0].line, '提要第一行应是 `**<先修 ／ 可以先用 ／ 先验证>** —— <最要紧的那条会造成什么>`');
    }
  }
  notes.push('提要');

  // ---- 三张表 + 覆盖表 ----
  const tables = [];
  for (let i = 0; i < vis.length; i++) {
    if (!vis[i].trimStart().startsWith('|')) continue;
    const t = tableAt(vis, i);
    if (t !== null) { tables.push(t); i = t.end - 1; }
  }
  const same = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);
  const pick = (head) => tables.filter((t) => same(t.header, head));
  const aTables = pick(A_HEAD);
  const bTables = pick(B_HEAD);
  const cTables = pick(C_HEAD);
  const dTables = pick(D_HEAD);
  const coverTables = pick(COVER_HEAD);

  const unknown = tables.filter((t) => ![A_HEAD, B_HEAD, C_HEAD, D_HEAD, COVER_HEAD].some((h) => same(t.header, h)));
  for (const t of unknown) fail(t.start, `表头不认识（${t.header.join(' | ')}）——列名按本件，不许省、不许改`);

  if (aTables.length > 1) for (const t of aTables.slice(1)) fail(t.start, 'A 表只能有一张');
  if (bTables.length > 1) for (const t of bTables.slice(1)) fail(t.start, 'B 表只能有一张');
  if (cTables.length > 1) for (const t of cTables.slice(1)) fail(t.start, 'C 表只能有一张');

  const A = aTables[0] ?? null;
  const B = bTables[0] ?? null;
  const C = cTables[0] ?? null;
  const D = dTables[0] ?? null;

  const discoveryStart = h2[0]?.line ?? 0;
  const decisionStart = h2[1]?.line ?? 0;
  const stopStart = h2[2]?.line ?? 0;

  if (A === null) {
    // 零发现是唯一例外
    const window = vis.slice(discoveryStart, decisionStart > discoveryStart ? decisionStart - 1 : vis.length).join('\n');
    if (!window.includes('未发现')) fail(discoveryStart + 1, '没有 A 表时，发现段必须写一行「未发现 —— 逐册表态与覆盖限制见下」');
    if (B !== null) fail(B.start, '没有 A 表却出现了 B 表');
    const cwin = vis.slice(decisionStart, stopStart > decisionStart ? stopStart - 1 : vis.length).join('\n');
    if (C !== null) fail(C.start, '没有发现时，决策点写一行「无」，不用表');
    else if (!cwin.split('\n').some((l) => l.trim() === '无')) fail(decisionStart + 1, '没有发现时，决策点段应单独写一行「无」');
  } else {
    if (B === null) fail(A.start, '有 A 表却没有 B 表——A 表每一行都要有同号的一行担保');
    else {
      const gap = vis.slice(A.end, B.start - 1).filter((l) => l.trim() !== '');
      if (gap.length > 0) fail(B.start, 'B 表应紧跟 A 表，中间只隔一个空行');
      const aIds = A.rows.map((r) => r.cells[0]);
      const bIds = B.rows.map((r) => r.cells[0]);
      if (aIds.length !== bIds.length) fail(B.start, `A 表 ${aIds.length} 条，B 表 ${bIds.length} 条——两张表必须同条数`);
      const missing = aIds.filter((id) => !bIds.includes(id));
      const extra = bIds.filter((id) => !aIds.includes(id));
      if (missing.length > 0) fail(B.start, `B 表缺 #${missing.join(' #')}`);
      if (extra.length > 0) fail(B.start, `B 表多出 #${extra.join(' #')}（A 表里没有）`);
      if (aIds.some((id, k) => id !== String(k + 1))) fail(A.start, `A 表的 # 应从 1 连续排到 ${aIds.length}`);
    }
  }

  // ---- 级别与依据的用词 ----
  if (A !== null) {
    for (const r of A.rows) {
      const [id, level, evidence, position, problem, fix] = r.cells;
      if (!LEVELS.includes(level)) fail(r.line, `#${id} 的级别「${level}」不是三个词之一（${LEVELS.join('／')}）`);
      const m = /^(读源码|跑了命令|引了原文|推断)(?:（(可证|一环未读全|存疑)）)?$/.exec(evidence);
      if (m === null) fail(r.line, `#${id} 的依据「${evidence}」不合形——只写 ${EVIDENCE.join('／')}，确认程度（${CONFIDENCE.join('／')}）写在同一括注里`);
      else if (EVIDENCE.indexOf(m[1]) === -1) fail(r.line, `#${id} 的依据不在四个词之内`);
      if (!/:[0-9]/.test(position) && !/-[0-9]+\b/.test(position)) fail(r.line, `#${id} 的位置「${position}」没有行号——写成 \`<文件>:<行>\``);
      if (problem.length === 0 || fix.length === 0) fail(r.line, `#${id} 的「问题」或「修复方向」空着`);
      for (const t of ['上面', '该条', '这两处', '前文']) {
        if (new RegExp(`${t}`).test(problem)) fail(r.line, `#${id} 的问题列出现「${t}」——这一行必须自足`);
      }
    }
    // 排序
    const rankLevel = (s) => LEVELS.indexOf(s);
    const rankEv = (s) => {
      const k = EVIDENCE.indexOf(s.replace(/（.*$/, ''));
      return k === -1 ? 9 : k;
    };
    for (let i = 1; i < A.rows.length; i++) {
      const p = A.rows[i - 1];
      const q = A.rows[i];
      const cmp = rankLevel(p.cells[1]) - rankLevel(q.cells[1]) || rankEv(p.cells[2]) - rankEv(q.cells[2]);
      if (cmp > 0) fail(q.line, `#${q.cells[0]} 排在 #${p.cells[0]} 之后，但更轻（顺序：级别 → 依据 → 位置）`);
      if (cmp === 0) {
        const pl = Number(/:\s*(\d+)/.exec(p.cells[3])?.[1] ?? /-(\d+)/.exec(p.cells[3])?.[1] ?? 0);
        const ql = Number(/:\s*(\d+)/.exec(q.cells[3])?.[1] ?? /-(\d+)/.exec(q.cells[3])?.[1] ?? 0);
        if (pl > ql) fail(q.line, `#${q.cells[0]} 与 #${p.cells[0]} 同级同依据，但位置更靠前`);
      }
    }
    const severe = A.rows.filter((r) => r.cells[1] === '严重').length;
    const anchors = lines.filter((l) => l.includes('独立依据')).length;
    if (severe > anchors) fail(A.start, `标「严重」${severe} 条，但全文只有 ${anchors} 处「独立依据」——填不出就降到「待查」`);
    if (A.rows.length > 12) {
      const rest = lines.find((l) => /另\s*\d+\s*条见账本/.test(l));
      if (rest === undefined) fail(A.start, `A 表 ${A.rows.length} 条，超过 12 条却没有一行「另 <N> 条见账本 \`<路径>\``);
    }
  }

  // ---- C 表 ----
  if (C !== null) {
    if (C.rows.length > 3) fail(C.start, `决策点至多 3 行，实际 ${C.rows.length} 行`);
    for (const r of C.rows) {
      const [id, form, cur, lean, held] = r.cells;
      if (!FORMS.includes(form)) fail(r.line, `决策点 #${id} 的形态「${form}」不是 ${FORMS.join('／')} 之一`);
      if (form === '根' && (held === undefined || held.trim() === '' || held.trim() === '-')) {
        fail(r.line, `决策点 #${id} 是「根」，但「挂住的条目」空着——根要几条才看得见`);
      }
      if (cur === '' || lean === '') fail(r.line, `决策点 #${id} 的「现状或位置」或「倾向」空着`);
    }
  }

  // ---- D 表 ----
  if (D === null) fail(stopStart + 1, '缺 D 表（停止审查的依据，一行一册）');
  else {
    for (const r of D.rows) {
      const [ref, verdict, basis] = r.cells;
      if (!ref.includes('references/')) fail(r.line, `D 表的分册应写成 \`references/<名>.md\`，实际「${ref}」`);
      if (!/^(有发现|无发现|不适用|未加载)/.test(verdict)) fail(r.line, `D 表的表态应以下列之一开头：有发现／无发现／不适用＋理由／未加载：<理由>，实际「${verdict}」`);
      if (verdict.startsWith('未加载') && !verdict.includes('：')) fail(r.line, '「未加载」后面要跟理由（`未加载：<为什么这个对象用不到它>`）');
      if (basis === '') fail(r.line, `D 表「${ref}」的判据空着——数得出来的才算走过`);
    }
  }
  notes.push('三张表');

  // ---- 账本与用量行 ----
  const ledgerIdx = lines.findIndex((l) => /^账本\s/.test(l));
  let ledgerTotal = null;
  if (ledgerIdx >= 0) {
    const m = /^账本\s+`?([^`]+?)`?\s*·\s*(\d+)\s*条（上表\s*(\d+)\s*条）/.exec(lines[ledgerIdx]);
    if (m === null) fail(ledgerIdx + 1, '账本行不合形：`账本 <路径> · <N> 条（上表 <k> 条）`');
    else {
      ledgerTotal = Number(m[2]);
      const k = Number(m[3]);
      const declared = lines.some((l) => l.includes('不随报告交付'));
      const p = isAbsolute(m[1]) ? m[1] : join(dirname(reportPath), m[1]);
      if (!declared && !existsSync(p)) fail(ledgerIdx + 1, `账本路径够不着（${m[1]}）——要么随报告交付，要么在这一行明说它不随报告交付`);
      if (A !== null && k !== A.rows.length) fail(ledgerIdx + 1, `账本行说「上表 ${k} 条」，A 表实际 ${A.rows.length} 条`);
      const rest = /另\s*(\d+)\s*条见账本/.exec(lines.join('\n'));
      if (rest !== null && Number(rest[1]) + k !== ledgerTotal) {
        fail(ledgerIdx + 1, `账本 ${ledgerTotal} 条、上表 ${k} 条、另 ${rest[1]} 条——三个数对不上，读者不该替你做减法`);
      }
    }
  }

  const last = (() => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() !== '') return { line: i + 1, text: lines[i].trim() };
    return null;
  })();
  const usageRe = /^`?提要\s*(\d+)\s*行\s*·\s*A\s*表\s*(\d+)\s*条\s*·\s*B\s*表\s*(\d+)\s*条\s*·\s*展开\s*(\d+)\s*段\s*·\s*决策点\s*(\d+)\s*条`?$/;
  const usage = last === null ? null : usageRe.exec(last.text);
  if (usage === null) fail(last?.line ?? null, '最后一行必须是用量行：`提要 <N> 行 · A 表 <N> 条 · B 表 <N> 条 · 展开 <N> 段 · 决策点 <N> 条`');
  else {
    const want = {
      提要: quote.length,
      'A 表': A === null ? 0 : A.rows.length,
      'B 表': B === null ? 0 : B.rows.length,
      展开: vis.filter((l) => /^\*\*#\d+\s*展开\*\*$/.test(l.trim())).length,
      决策点: C === null ? 0 : C.rows.length,
    };
    const got = [Number(usage[1]), Number(usage[2]), Number(usage[3]), Number(usage[4]), Number(usage[5])];
    const names = ['提要', 'A 表', 'B 表', '展开', '决策点'];
    names.forEach((n, i) => {
      if (got[i] !== want[n]) fail(last.line, `用量行说${n} ${got[i]}，实际 ${want[n]}`);
    });
  }
  const check = lines.findIndex((l) => /^校验\s/.test(l));
  if (check >= 0 && !/^校验\s*(通过|未通过：|未跑：)/.test(lines[check])) {
    fail(check + 1, '校验行只有三种写法：`校验 通过`、`校验 未通过：<条目>`、`校验 未跑：<原因>`');
  }
  notes.push('账本与用量');

  // ---- 不许出现 ----
  // 只认图形符号：箭头（→）、破折号、数学符号是正文的一部分，不算图标。
  const emoji = /(?:\p{Extended_Pictographic}|[\u2705\u2714\u2716\u26A0\u2699\u{FE0F}])/u;
  for (let i = 0; i < lines.length; i++) {
    if (emoji.test(lines[i])) fail(i + 1, '出现了图标或 emoji');
  }
  for (let i = 0; i < vis.length; i++) {
    if (/<\/?(details|summary|div|span|br|img|table|style)\b/i.test(vis[i])) fail(i + 1, '不许写 HTML（折叠块、内联样式都算）');
    const ph = /<[^<>\n]{1,60}>/.exec(vis[i]);
    if (ph !== null && !ph[0].startsWith('<http')) fail(i + 1, `还有没填的尖括号槽位：${ph[0]}`);
  }
  return { problems, notes };
}

// 命令行入口：被 import 时不跑（自测夹具就是这样复用它，不必起子进程）。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('用法：node verify-report.mjs <报告.md> [<报告.md> ...]');
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`找不到报告：${f}`);
      process.exitCode = 2;
      continue;
    }
    const { problems, notes } = scanText(f, readFileSync(f, 'utf8'));
    if (problems.length === 0) {
      console.log(`OK   ${f}（${notes.join('、')}）`);
    } else {
      bad += problems.length;
      console.log(`FAIL ${f}`);
      for (const p of problems) console.log(`  - ${p}`);
    }
  }
  if (bad > 0) {
    console.log(`\n${bad} 项不通过。改完再跑一次。`);
    process.exitCode = 1;
  } else {
    console.log('\n全部通过。');
  }
}
