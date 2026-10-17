#!/usr/bin/env node
// 报告外形校验：只查**结构、算术、用词、可达性**。
//
// 用法：node verify-report.mjs <报告.md> [<报告.md> ...]
// 退出码：0 全部通过；1 有不通过项；2 读取失败。
//
// **它不判断一条发现对不对**，也不读被审对象。一旦开始判断内容，它就会误判，
// 而一个会误判的闸门比没有闸门更坏——跑两次失败之后，人就不跑了。
// 这里只认那些能机械判真假的事：块的顺序、两张表同号同条数、用量行自己报的数、
// 账本行的减法、依据与级别的用词、标「严重」有没有独立依据。
//
// 输出是给人看的：每条不通过都带行号与期望值，改完再跑一次。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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

// format.md §六与提要规则明令禁止的写法。长的在前：一个词被长词包含时只报长的那个。
const BANNED = ['没有遗漏', '都查过了', '可以放行', '没有问题', '不能合', '能合'];

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
  return { header, rows, start: start + 1, end: i, startIdx: start, endIdx: i - 1 };
}

const stripCode = (s) => s.replace(/`[^`]*`/g, '');
const cell = (r, i) => (r.cells[i] === undefined ? '' : r.cells[i]);

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
    if (m !== null) heads.push({ line: i + 1, idx: i, level: m[1].length, text: m[2].trim() });
  }
  const h1 = heads.filter((h) => h.level === 1);
  if (h1.length === 0) fail(null, '缺一级标题（`# 评审报告 · <对象名>`）');
  else if (h1.length > 1) fail(h1[1].line, `一级标题只能有一个，这里出现了 ${h1.length} 个`);
  else if (!/^评审报告/.test(h1[0].text)) fail(h1[0].line, '一级标题应以「评审报告」开头');

  const h2 = heads.filter((h) => h.level === 2);
  const h2Idx = h2.map((h) => h.idx);
  if (h2.length !== SECTION_NAMES.length) {
    fail(h2.length > 0 ? h2[0].line : null, `二级标题应恰好 ${SECTION_NAMES.length} 个（${SECTION_NAMES.map((s) => `## ${s}`).join('、')}），实际 ${h2.length} 个`);
  }
  for (let i = 0; i < Math.min(h2.length, SECTION_NAMES.length); i++) {
    if (h2[i].text !== SECTION_NAMES[i]) fail(h2[i].line, `第 ${i + 1} 个二级标题应为「${SECTION_NAMES[i]}」，实际「${h2[i].text}」——段名一个字都不改`);
  }
  for (const h of h2.slice(SECTION_NAMES.length)) {
    fail(h.line, `多余的二级标题「${h.text}」——除「${SECTION_NAMES.join('」「')}」外不许有二级标题`);
  }
  const deep = heads.filter((h) => h.level >= 3);
  for (const h of deep) fail(h.line, `不许有 ${'#'.repeat(h.level)} 标题（「${h.text}」）——三张表与展开都不立标题`);

  /** 第 k 个二级标题下（不含标题行、不含下一个标题）的可见行。 */
  const sectionLines = (k) => {
    if (k < 0 || k >= h2Idx.length) return [];
    const from = h2Idx[k] + 1;
    const to = k + 1 < h2Idx.length ? h2Idx[k + 1] : vis.length;
    return vis.slice(from, to);
  };
  const sectionOf = (idx) => {
    let k = -1;
    for (let j = 0; j < h2Idx.length; j++) if (h2Idx[j] < idx) k = j;
    return k;
  };

  // ---- 提要 ----
  const firstH2 = h2.length > 0 ? h2[0].idx : vis.length;
  const quote = [];
  for (let i = 0; i < firstH2; i++) if (/^\s*>/.test(vis[i])) quote.push({ line: i + 1, text: vis[i] });
  if (quote.length !== 2) fail(quote.length > 0 ? quote[0].line : null, `提要应是引用块里的两行（结论、范围／未查），实际 ${quote.length} 行`);
  else {
    if (!quote[1].text.includes('范围')) fail(quote[1].line, '提要第二行缺「范围」');
    if (!quote[1].text.includes('未查')) fail(quote[1].line, '提要第二行缺「未查」——"未查"写在这里，不是文末');
    // 第一行是**一句话**：说清最要紧的问题与后果。不加标签、不加粗、不用审批词——
    // 读者从零开始读，他要听的是事，不是档案编号。
    const head = quote[0].text.replace(/^\s*>\s*/, '').trim();
    const labelled = /^\*\*/.test(head) || /^(先修|可以先用|先验证)\b/.test(head);
    if (labelled || /不能合|(?<!不)能合(?!并)|可合|不可合|放行/.test(head)) {
      fail(quote[0].line, '提要第一行直接说事：不加粗、不套「能合／不能合／放行」或「先修／可以先用／先验证」这类标签');
    } else if (head.length < 8 || !/[。！？][”’"\'）)]*$/.test(head)) {
      fail(quote[0].line, '提要第一行应是一句话（完整、以句号收尾），不是标签或短语');
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
  // 先比格数，再解构：少一格时后面的解构会拿到 undefined，
  // 一条外形错误就会以 TypeError + 堆栈结束整次校验。
  for (const t of tables) {
    for (const r of t.rows) {
      if (r.cells.length !== t.header.length) {
        fail(r.line, `这一行 ${r.cells.length} 格，表头 ${t.header.length} 格（含裸 \`|\` 或列数不对）`);
      }
    }
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

  // ---- 块序：每张表落在哪一段 ----
  // 「发现的问题」「决策点」「停止审查的依据」按位置认：段名错了上面的检查已经报过，
  // 这里查的是表有没有被挪到别的标题下。
  if (A !== null && sectionOf(A.startIdx) !== 0) {
    fail(A.start, 'A 表必须落在「发现的问题」段内——块序固定，不许挪到别的标题下');
  }
  if (B !== null && sectionOf(B.startIdx) !== 0) {
    fail(B.start, 'B 表必须落在「发现的问题」段内——它是 A 表的担保，不许挪到别的标题下');
  }
  if (C !== null && sectionOf(C.startIdx) !== 1) {
    fail(C.start, 'C 表必须落在「决策点」段内——块序固定，不许挪到别的标题下');
  }
  if (D !== null && sectionOf(D.startIdx) !== 2) {
    fail(D.start, 'D 表必须落在「停止审查的依据」段内——块序固定，不许挪到别的标题下');
  }
  for (const t of coverTables) {
    if (sectionOf(t.startIdx) !== 2) fail(t.start, '覆盖表必须落在「停止审查的依据」段内——块序固定，不许挪到别的标题下');
  }

  const decisionStart = h2Idx[1] ?? -1;
  const stopStart = h2Idx[2] ?? -1;

  if (A === null) {
    // 零发现是唯一例外
    const window = sectionLines(0).join('\n');
    if (!window.includes('未发现 —— 逐册表态与覆盖限制见下')) {
      fail(h2Idx[0] !== undefined ? h2Idx[0] + 2 : null, '没有 A 表时，发现段必须写一行「未发现 —— 逐册表态与覆盖限制见下」');
    }
    if (B !== null) fail(B.start, '没有 A 表却出现了 B 表');
    const cwin = sectionLines(1).join('\n');
    if (C !== null) fail(C.start, '没有发现时，决策点写一行「无」，不用表');
    else if (!cwin.split('\n').some((l) => l.trim() === '无')) fail(decisionStart + 2, '没有发现时，决策点段应单独写一行「无」');
  } else {
    if (A.rows.length === 0) {
      fail(A.start, 'A 表 0 行：空表不算零发现——整块删掉，写一行「未发现 —— 逐册表态与覆盖限制见下」');
    }
    if (B === null) fail(A.start, '有 A 表却没有 B 表——A 表每一行都要有同号的一行担保');
    else {
      if (B.startIdx < A.startIdx) fail(B.start, 'B 表应在 A 表之后');
      const gap = vis.slice(A.end, B.start - 1).filter((l) => l.trim() !== '');
      if (gap.length > 0) fail(B.start, 'B 表应紧跟 A 表，中间只隔一个空行');
      const aIds = A.rows.map((r) => cell(r, 0));
      const bIds = B.rows.map((r) => cell(r, 0));
      if (aIds.length !== bIds.length) fail(B.start, `A 表 ${aIds.length} 条，B 表 ${bIds.length} 条——两张表必须同条数`);
      const missing = aIds.filter((id) => !bIds.includes(id));
      const extra = bIds.filter((id) => !aIds.includes(id));
      if (missing.length > 0) fail(B.start, `B 表缺 #${missing.join(' #')}`);
      if (extra.length > 0) fail(B.start, `B 表多出 #${extra.join(' #')}（A 表里没有）`);
      if (aIds.some((id, k) => id !== String(k + 1))) fail(A.start, `A 表的 # 应从 1 连续排到 ${aIds.length}`);
    }
    // 有发现时决策点段不能空：至少要有 C 表，或一行兜底句。
    const cwin = sectionLines(1);
    const hasFallback = cwin.some((l) => l.trim() === '零散问题，逐个修' || l.trim() === '无');
    if (C === null && !hasFallback) {
      fail(decisionStart + 2, `A 表有 ${A.rows.length} 条，决策点段却空着——至少写 C 表，或一行「零散问题，逐个修」／「无」`);
    }
  }

  // ---- 级别与依据的用词 ----
  const aRows = A === null ? [] : A.rows.filter((r) => r.cells.length === A.header.length);
  if (A !== null) {
    for (const r of aRows) {
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
    for (let i = 1; i < aRows.length; i++) {
      const p = aRows[i - 1];
      const q = aRows[i];
      const cmp = rankLevel(cell(p, 1)) - rankLevel(cell(q, 1)) || rankEv(cell(p, 2)) - rankEv(cell(q, 2));
      if (cmp > 0) fail(q.line, `#${q.cells[0]} 排在 #${p.cells[0]} 之后，但更轻（顺序：级别 → 依据 → 位置）`);
      if (cmp === 0) {
        // 位置是「文件:行」，文件之间的先后按路径比、同一个文件内才按行号比。
        // 只比行号会把 src/table/foo.rs:20 判成该排在 src/cmd/bar.rs:900 之后——
        // 跨文件的行号本来就没有可比性。
        const splitPos = (s) => {
          const t = s.replace(/[\`]/g, '').trim();
          const k = t.lastIndexOf(':');
          return k === -1 ? [t, 0] : [t.slice(0, k), Number(t.slice(k + 1).replace(/[^0-9].*$/, '')) || 0];
        };
        const [pf, pl] = splitPos(cell(p, 3));
        const [qf, ql] = splitPos(cell(q, 3));
        if (pf < qf) { /* 文件先后正确 */ }
        else if (pf > qf) fail(q.line, `#${q.cells[0]} 与 #${p.cells[0]} 同级同依据，但位置更靠前`);
        else if (pl > ql) fail(q.line, `#${q.cells[0]} 与 #${p.cells[0]} 同级同依据，但位置更靠前`);
      }
    }

    // 依据与级别相容
    const severeRows = aRows.filter((r) => cell(r, 1) === '严重');
    for (const r of severeRows) {
      if (cell(r, 2).replace(/（.*$/, '') === '推断') {
        fail(r.line, `#${cell(r, 0)} 标「严重」但依据是「推断」——contract.md 说推断不得定为最高级，降到「待查」`);
      }
    }
    const anchors = (vis.join('\n').match(/独立依据：/g) ?? []).length;
    if (severeRows.length > anchors) {
      fail(A.start, `标「严重」${severeRows.length} 条，但全文只有 ${anchors} 处「独立依据：」——每个严重条目都要有独立依据，填不出就降到「待查」`);
    }
    if (A.rows.length > 12) {
      const rest = lines.find((l) => /另\s*\d+\s*条见账本/.test(l));
      if (rest === undefined) fail(A.start, `A 表 ${A.rows.length} 条，超过 12 条却没有一行「另 <N> 条见账本 \`<路径>\``);
    }
  }

  // ---- 独立依据 ----
  // 必须写成 `独立依据：<仪器>`：带前缀与全角冒号；没有「严重」条目时不许出现。
  const severeCount = aRows.filter((r) => cell(r, 1) === '严重').length;
  let firstAnchorLine = null;
  // 只有**声明**独立依据的行才检查写法：正文里提到「独立依据」三个字（"没有独立依据"、
  // "每个严重条目都要有独立依据"）是在说规则本身，不是槽位。判据是它后面跟冒号，
  // 或者整行就以这三个字收尾（标题行不算）。
  for (let i = 0; i < vis.length; i++) {
    const line = vis[i];
    if (!line.includes('独立依据')) continue;
    if (/^#{1,6}\s/.test(line.trim())) continue;
    // 只在**声明**处认这个槽位：行首、表格的 `|`、或 ` · ` 分隔之后；正文里
    // 「没有独立依据」「每个严重条目都要有独立依据」是在说规则本身，不是槽位。
    const declares = /(^|[\s·|（(、])独立依据/.test(line) || /独立依据\s*[：:]/.test(line);
    if (!declares) continue;
    if (firstAnchorLine === null) firstAnchorLine = i + 1;
    if (!/独立依据：\s*\S/.test(line)) {
      fail(i + 1, '独立依据行必须写成「独立依据：<仪器>」——全角冒号，仪器紧跟其后');
    }
  }
  if (severeCount === 0 && firstAnchorLine !== null) {
    fail(firstAnchorLine, '没有「严重」条目却出现「独立依据：」——format.md §八 禁止');
  }

  // ---- 展开：标「严重」＋「跑了命令」的三件套 ----
  const expansions = [];
  for (let i = 0; i < vis.length; i++) {
    const m = /^\*\*#(\d+)\s*展开\*\*$/.exec(vis[i].trim());
    if (m === null) continue;
    let j = i + 1;
    for (; j < vis.length; j++) {
      if (/^\*\*#\d+\s*展开\*\*$/.test(vis[j].trim())) break;
      if (/^#{1,6}\s/.test(vis[j])) break;
    }
    expansions.push({ id: Number(m[1]), line: i + 1, body: lines.slice(i + 1, j), bodyVis: vis.slice(i + 1, j) });
    i = j - 1;
  }
  for (const r of aRows) {
    if (cell(r, 1) !== '严重' || cell(r, 2).replace(/（.*$/, '') !== '跑了命令') continue;
    const id = Number(cell(r, 0));
    const ex = expansions.find((e) => e.id === id);
    if (ex === undefined) {
      fail(r.line, `#${id} 标「严重」且依据是「跑了命令」，但没有 **#${id} 展开**——命令三件套要贴在展开里`);
      continue;
    }
    const ci = ex.bodyVis.findIndex((l) => /命令\s*`/.test(l));
    const ei = ex.bodyVis.findIndex((l) => /退出码\s*`/.test(l));
    if (ci === -1) fail(ex.line, `#${id} 的展开缺「命令 \`<完整命令>\`」`);
    if (ei === -1) fail(ex.line, `#${id} 的展开缺「退出码 \`<N>\`」`);
    const from = Math.max(ci, ei);
    if (from !== -1) {
      let k = from + 1;
      while (k < ex.body.length && ex.body[k].trim() === '') k++;
      if (k >= ex.body.length || !/^\s*(`{3,}|~{3,})/.test(ex.body[k])) {
        fail(ex.line, `#${id} 的展开：命令三件套后面要紧跟一个围栏代码块放未经筛选的输出`);
      }
    }
  }

  // ---- C 表 ----
  const cRows = C === null ? [] : C.rows.filter((r) => r.cells.length === C.header.length);
  if (C !== null) {
    if (C.rows.length > 3) fail(C.start, `决策点至多 3 行，实际 ${C.rows.length} 行`);
    for (const r of cRows) {
      const [id, form, cur, lean, held] = r.cells;
      if (!FORMS.includes(form)) fail(r.line, `决策点 #${id} 的形态「${form}」不是 ${FORMS.join('／')} 之一`);
      if (form === '根') {
        const heldIds = (held || '').match(/#\d+/g) || [];
        if (held.trim() === '' || held.trim() === '-') {
          fail(r.line, `决策点 #${id} 是「根」，但「挂住的条目」空着——根要几条才看得见`);
        } else if (heldIds.length < 2) {
          fail(r.line, `决策点 #${id} 是「根」，但只挂住 ${heldIds.length} 条——根至少要两条，一条发现不谈根`);
        }
      }
      if (cur === '' || lean === '') fail(r.line, `决策点 #${id} 的「现状或位置」或「倾向」空着`);
    }
  }

  // ---- D 表 ----
  if (D === null) fail(stopStart + 2, '缺 D 表（停止审查的依据，一行一册）');
  else {
    const dRows = D.rows.filter((r) => r.cells.length === D.header.length);
    for (const r of dRows) {
      const [ref, verdict, basis] = r.cells;
      if (!ref.includes('references/')) fail(r.line, `D 表的分册应写成 \`references/<名>.md\`，实际「${ref}」`);
      if (!/^(有发现|无发现|不适用|未加载)/.test(verdict)) fail(r.line, `D 表的表态应以下列之一开头：有发现／无发现／不适用＋理由／未加载：<理由>，实际「${verdict}」`);
      if (verdict.startsWith('未加载') && !verdict.includes('：')) fail(r.line, '「未加载」后面要跟理由（`未加载：<为什么这个对象用不到它>`）');
      if (basis === '') fail(r.line, `D 表「${ref}」的判据空着——数得出来的才算走过`);
    }
  }
  notes.push('三张表');

  // ---- 账本与用量行 ----
  const ledgerIdx = vis.findIndex((l) => /^账本\s/.test(l));
  if (ledgerIdx >= 0) {
    const m = /^账本\s+`?([^`]+?)`?\s*·\s*(\d+)\s*条（上表\s*(\d+)\s*条）/.exec(vis[ledgerIdx]);
    if (m === null) fail(ledgerIdx + 1, '账本行不合形：`账本 <路径> · <N> 条（上表 <k> 条）`');
    else {
      const ledgerTotal = Number(m[2]);
      const k = Number(m[3]);
      const declared = vis.some((l) => l.includes('不随报告交付'));
      // 路径基准有两个：报告所在目录（报告与账本通常放在一起），以及当前目录
      // （账本在工作区根、报告在子目录里时，写的是相对根的那个路径）。都试一次，
      // 只要有一个够得着就算过——够不着才是错误。
      const candidates = isAbsolute(m[1]) ? [m[1]] : [join(dirname(reportPath), m[1]), resolve(m[1])];
      const reachable = candidates.some((q) => existsSync(q));
      if (!declared && !reachable) fail(ledgerIdx + 1, `账本路径够不着（${m[1]}）——按报告所在目录与当前目录都没找到；要么随报告交付，要么在这一行明说它不随报告交付`);
      if (A !== null && k !== A.rows.length) fail(ledgerIdx + 1, `账本行说「上表 ${k} 条」，A 表实际 ${A.rows.length} 条`);
      const rest = /另\s*(\d+)\s*条见账本/.exec(lines.join('\n'));
      if (rest === null) {
        if (ledgerTotal !== k) {
          fail(ledgerIdx + 1, `账本 ${ledgerTotal} 条、上表 ${k} 条——没有「另 M 条见账本」行时两个数必须相等`);
        }
      } else if (Number(rest[1]) + k !== ledgerTotal) {
        fail(ledgerIdx + 1, `账本 ${ledgerTotal} 条、上表 ${k} 条、另 ${rest[1]} 条——三个数对不上，读者不该替你做减法`);
      }
    }
  }

  const lastIdx = (() => {
    for (let i = vis.length - 1; i >= 0; i--) if (vis[i].trim() !== '') return i;
    return -1;
  })();
  const prevIdx = (() => {
    for (let i = lastIdx - 1; i >= 0; i--) if (vis[i].trim() !== '') return i;
    return -1;
  })();
  const last = lastIdx >= 0 ? { line: lastIdx + 1, text: vis[lastIdx].trim() } : null;
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

  // ---- 校验行：紧挨用量行之上 ----
  let checkIdx = -1;
  for (let i = 0; i < vis.length; i++) {
    if (/^校验\s/.test(vis[i].trim())) { checkIdx = i; break; }
  }
  const checkRe = /^校验\s*(?:通过|未通过：.+|未跑：.+)$/;
  if (checkIdx === -1) {
    fail(last?.line ?? null, '没有 `校验` 行——不写等于隐瞒');
  } else {
    if (checkIdx !== prevIdx) {
      fail(checkIdx + 1, '校验行必须在用量行正上方（倒数第二行），它紧挨用量行之上');
    }
    if (!checkRe.test(vis[checkIdx].trim())) {
      fail(checkIdx + 1, '校验行只有三种写法：`校验 通过`、`校验 未通过：<条目>`、`校验 未跑：<原因>`');
    }
  }
  notes.push('账本与用量');

  // ---- 不许出现 ----
  // 只认图形符号：箭头（→）、破折号、数学符号是正文的一部分，不算图标。
  // emoji 与 HTML 都查**已遮罩**的文本：贴的是未经筛选的命令输出，输出里有 ✅ 不算报告用图标。
  const emoji = /(?:\p{Extended_Pictographic}|[\u2705\u2714\u2716\u26A0\u2699\u{FE0F}])/u;
  for (let i = 0; i < vis.length; i++) {
    if (emoji.test(vis[i])) fail(i + 1, '出现了图标或 emoji');
  }
  for (let i = 0; i < vis.length; i++) {
    if (/<\/?(details|summary|div|span|br|img|table|style)\b/i.test(vis[i])) fail(i + 1, '不许写 HTML（折叠块、内联样式都算）');
    // 只报「含中文或含 …」的尖括号：`Vec<u8>`、`Option<T>` 是代码，不是没填的槽位。
    for (const m of vis[i].matchAll(/<([^<>\n]{1,60})>/g)) {
      if (m[0].startsWith('<http')) continue;
      if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef…]/.test(m[1])) {
        fail(i + 1, `还有没填的尖括号槽位：${m[0]}`);
      }
    }
  }

  // ---- 禁句 ----
  // 只查表格数据行、提要行与收尾行；围栏代码块与行内代码里的字样不算（那可能是元讨论或输出）。
  const bannedLines = [];
  for (const t of tables) for (const r of t.rows) bannedLines.push({ line: r.line, text: r.cells.join(' | ') });
  for (const q of quote) bannedLines.push({ line: q.line, text: q.text });
  const lastTableEnd = tables.reduce((mx, t) => Math.max(mx, t.endIdx), -1);
  const closeTo = prevIdx >= 0 ? prevIdx : lastIdx;
  for (let i = lastTableEnd + 1; i < closeTo; i++) {
    if (vis[i].trim() === '') continue;
    if (/^校验\s/.test(vis[i].trim())) continue;
    bannedLines.push({ line: i + 1, text: vis[i] });
  }
  for (const cand of bannedLines) {
    const plain = stripCode(cand.text);
    for (const phrase of BANNED) {
      // 「能合」是「不能合」「能合并」的子串：长词先命中即跳出，且排除「能合并」这种复合词。
      const hit = phrase === '能合' ? /(?<!不)能合(?!并)/.test(plain) : plain.includes(phrase);
      if (hit) {
        fail(cand.line, `出现了禁句「${phrase}」——format.md §六与提要规则明令禁止（审批词、完整性命题）`);
        break;
      }
    }
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
  let unreadable = 0;
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`找不到报告：${f}`);
      unreadable++;
      process.exitCode = 2;
      continue;
    }
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch (err) {
      console.error(`读不了报告：${f}（${err.message}）`);
      unreadable++;
      process.exitCode = 2;
      continue;
    }
    const { problems, notes } = scanText(f, text);
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
  } else if (unreadable > 0) {
    console.log(`\n${unreadable} 个文件读不了。`);
  } else {
    console.log('\n全部通过。');
  }
}
