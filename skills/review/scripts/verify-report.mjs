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
// 四种结构特征是主名；`收口`／`默认值` 是前两种的旧名，旧报告仍可过。
const FORMS = ['同一表示', '同一判据', '同一路径', '同一生命周期', '收口', '默认值'];
const MERGE_TWO = ['同一表示', '同一判据', '收口'];
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

/** 校验一份报告的正文，返回 { problems, notes }。不读被审对象。 */
const STRICT = process.argv.includes('--strict');
export function scanText(reportPath, text) {
  const problems = [];
  const notes = [];
  const lines = norm(text).split('\n');
  const vis = maskFences(lines);
  const at = (n) => `${reportPath}:${n}`;
  // 外形不是规范：只有语义类判据算错，其余记提示。`--strict` 把提示也当错（自查时用）。
  const SEMANTIC = /位置|依据|级别|严重|独立依据|槽位|HTML|图标|禁句|校验行|用量|账本|待答|症结|未决|问题列|修复方向|形态|挂住|根因覆盖|零散|同条数|没有 A 表却/;
  const fail = (n, msg) => {
    const line = n === null ? msg : `${at(n)} ${msg}`;
    if (!STRICT && !SEMANTIC.test(msg)) { notes.push(line); return; }
    problems.push(line);
  };

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
  for (const t of unknown) {
    const heads = [A_HEAD, B_HEAD, C_HEAD, D_HEAD, COVER_HEAD];
    const best = heads
      .map((h) => ({ h, hit: h.filter((x) => t.header.includes(x)).length }))
      .sort((a, b) => b.hit - a.hit)[0];
    const miss = best.h.filter((x) => !t.header.includes(x));
    const extra = t.header.filter((x) => !best.h.includes(x));
    const parts = [];
    if (miss.length > 0) parts.push(`缺 ${miss.map((x) => `「${x}」`).join('、')}`);
    if (extra.length > 0) parts.push(`多 ${extra.map((x) => `「${x}」`).join('、')}`);
    fail(
      t.start,
      `表头不认识（${t.header.join(' | ')}）——最接近「${best.h.join(' | ')}」：${parts.join('；') || '列名与它不同'}；列名不许省、不许改`,
    );
  }

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
    const hasFallback =
      cwin.some((l) => l.trim() === '零散问题，逐个修' || l.trim() === '无') || /零散[：:]/.test(text);
    if (C === null && !hasFallback) {
      fail(decisionStart + 2, `A 表有 ${A.rows.length} 条，决策点段却空着——至少写 C 表，或一行「零散：#1 #2」／「无」`);
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
      if (cmp > 0) notes.push(`第 ${q.line} 行：#${q.cells[0]} 排在 #${p.cells[0]} 之后但更轻（习惯顺序：级别 → 依据 → 位置），读者会先看到轻的`);
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
        else if (pf > qf || pl > ql) notes.push(`第 ${q.line} 行：#${q.cells[0]} 与 #${p.cells[0]} 同级同依据，但位置更靠前（习惯按文件路径、再按行号排）`);
      }
    }

    // 依据与级别相容
    const severeRows = aRows.filter((r) => cell(r, 1) === '严重');
    for (const r of severeRows) {
      if (cell(r, 2).replace(/（.*$/, '') === '推断') {
        fail(r.line, `#${cell(r, 0)} 标「严重」但依据是「推断」——contract.md 说推断不得定为最高级，降到「待查」`);
      }
    }
    // 仪器必须挂在**这一条**上，不能靠全文出现一次就算数：同号 B 表的「撤回条件」格，
    // 或这条自己的展开段。一份对同一处成立的仪器去担保别的条目，就是虚报。
    const pairForm =
      /独立依据：\s*两处代码路径对照[^|]*?[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+:\d+[^|]*?与[^|]*?[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+:\d+/;
    const ownInstrument = (id) => {
      const parts = [];
      if (B !== null) {
        for (const row of B.rows) if (cell(row, 0) === id) parts.push(row.cells.join(' | '));
      }
      const re = new RegExp(`^\\*\\*#${id} 展开\\*\\*$`);
      for (let i = 0; i < vis.length; i++) {
        if (!re.test(vis[i].trim())) continue;
        for (let j = i + 1; j < vis.length && !/^\*\*#\d+ 展开\*\*$/.test(vis[j].trim()) && !/^## /.test(vis[j]); j++) {
          parts.push(vis[j]);
        }
      }
      return parts.join('\n');
    };
    for (const r of severeRows) {
      const basis = cell(r, 2).replace(/（.*$/, '');
      if (basis !== '读源码') continue;
      if (!pairForm.test(ownInstrument(cell(r, 0)))) {
        fail(
          r.line,
          `#${cell(r, 0)} 依据是「读源码」却标「严重」——只有"两处代码路径对照"这一种仪器能在读源码下到严重，且两处都要指到行、写在这一条自己的同号 B 表格或展开段里（\`独立依据：两处代码路径对照 <a:行> 与 <b:行>\`）；换了别的仪器就把依据改成「跑了命令」或「引了原文」`,
        );
      }
    }
    const anchors = (vis.join('\n').match(/独立依据：/g) ?? []).length;
    if (severeRows.length > anchors) {
      fail(A.start, `标「严重」${severeRows.length} 条，但全文只有 ${anchors} 处「独立依据：」——每个严重条目都要有独立依据，填不出就降到「待查」`);
    }
    if (A.rows.length > 12) {
      const rest = lines.find((l) => /另\s*\d+\s*条见账本/.test(l));
      if (rest === undefined) notes.push(`A 表 ${A.rows.length} 条，多于样例的 12 条，也没有一行「另 <N> 条见账本 \`<路径>\``);
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
  // 决策点「挂住的条目」要能回指 A 表；A 表可能不存在（零发现），那时任何挂条目都算编的。
  const aIdSet = A === null ? [] : A.rows.map((r) => cell(r, 0));
  const cRows = C === null ? [] : C.rows.filter((r) => r.cells.length === C.header.length);
  if (C !== null) {
    for (const r of cRows) {
      const [id, form, cur, lean, held] = r.cells;
      if (!FORMS.includes(form)) fail(r.line, `决策点 #${id} 的形态「${form}」不是 ${FORMS.join('／')} 之一`);
      const heldIds = (held || '').match(/#\d+/g) || [];
      const need = MERGE_TWO.includes(form) ? 2 : 1;
      if (held.trim() === '' || held.trim() === '-') {
        fail(r.line, `决策点 #${id} 的「挂住的条目」空着——${form}至少要挂 ${need} 条`);
      } else if (heldIds.length < need) {
        fail(r.line, `决策点 #${id} 是「${form}」，只挂住 ${heldIds.length} 条——至少要 ${need} 条`);
      }
      for (const h of heldIds) {
        const n = h.slice(1);
        if (!aIdSet.includes(n)) fail(r.line, `决策点 #${id} 挂住了 ${h}，A 表里没有这一条`);
      }
      if (!/^修在\s*[^：]{1,24}：/.test(lean.replace(/^`+|`+$/g, '').trim())) {
        fail(r.line, `决策点 #${id} 的「倾向」要以「修在 <级别>：」开头（这一行／函数的契约／模块接口／项目规范／平台惯例）`);
      }
      if (cur === '') fail(r.line, `决策点 #${id} 的「现状或位置」空着`);
    }
  }

  // ---- 「根因覆盖」：有收口时必须把 A 表编号分成"这条根因解释的"与"不解释的"两组 ----
  // 判的是自洽（分完、不重、不与自己挂住的条目矛盾），不判根因对不对。
  const kouRows = cRows.filter((r) => MERGE_TWO.includes(cell(r, 1)));
  // 两条以上「收口」＝同一个判据被写了两遍：这是状态空间问题，不是"再多回源几条"。
  if (kouRows.length >= 2) {
    notes.push(
      `决策点里有 ${kouRows.length} 条合并（同一表示／同一判据）——这一轮已经走到状态空间门口了；按 references/state-space.md 导语的触发条件叠本册，给维度清单，才看得出同一空间里还有哪些组合也不该能构造`,
    );
  }
  if (kouRows.length > 0) {
    const coverLine = text
      .split('\n')
      .map((l) => l.trim().replace(/^\*\*|\*\*$/g, ''))
      .find((l) => /^根因覆盖[：:]/.test(l));
    if (coverLine === undefined) {
      fail(
        C.start,
        `有 ${kouRows.length} 条「收口」，却没有 \`根因覆盖：解释 #…；不解释 #…（原因）\` 这一行——一条根因自洽地挂住两条、漏掉十条，校验器不会响，除非你把\"它解释哪几条、解释不了哪几条\"写出来`,
      );
    } else {
      const body = coverLine.replace(/^根因覆盖[：:]\s*/, '');
      const cut = body.search(/不解释/);
      const explainPart = cut < 0 ? body : body.slice(0, cut);
      const noPart = cut < 0 ? '' : body.slice(cut);
      const explain = new Set((explainPart.match(/#\d+/g) || []).map((h) => h.slice(1)));
      const no = new Set((noPart.match(/#\d+/g) || []).map((h) => h.slice(1)));
      if (explain.size === 0) fail(C.start, '`根因覆盖` 的"解释"那一半一个编号都没有——要么写清它解释哪几条，要么说明没有收口');
      const dup = [...explain].filter((id) => no.has(id));
      if (dup.length > 0) fail(C.start, `#${dup.join(' #')} 同时出现在"解释"和"不解释"里`);
      const missing = aIdSet.filter((id) => !explain.has(id) && !no.has(id));
      if (missing.length > 0) fail(C.start, `#${missing.join(' #')} 没在 \`根因覆盖\` 里表态——每条发现都要么被这条根因解释，要么写明它属于另一层`);
      const ghostIds = [...explain, ...no].filter((id) => !aIdSet.includes(id));
      if (ghostIds.length > 0) fail(C.start, `\`根因覆盖\` 写了 #${ghostIds.join(' #')}，A 表里没有这几条`);
      const heldByKou = new Set();
      for (const r of kouRows) for (const h of cell(r, 4).match(/#\d+/g) || []) heldByKou.add(h.slice(1));
      const conflict = [...heldByKou].filter((id) => no.has(id));
      if (conflict.length > 0) {
        fail(C.start, `#${conflict.join(' #')} 合进了「收口」、又在 \`根因覆盖\` 里说"不解释"——合到一条根因下又说它不是这条根因，这个合并不成立`);
      }
    }
  }

  // ---- 每条 A 表条目要么归进某个决策点，要么进「零散」：恰好一次 ----
  // 这是对报告自己编号的分区检查，判的是事实（有没有漏、有没有重复），不是判断对错。
  const held = new Set();
  for (const r of cRows) {
    for (const h of cell(r, 4).match(/#\d+/g) || []) held.add(h.slice(1));
  }
  const allLines = text.split('\n').map((l) => l.trim());
  const scattered = new Set();
  let sawScattered = false;
  for (const l of allLines) {
    const m = /零散[：:]\s*([#\d\s无]*)/.exec(l);
    if (m === null) continue;
    sawScattered = true;
    for (const h of m[1].match(/#\d+/g) || []) scattered.add(h.slice(1));
  }
  if (aRows.length > 0) {
    const ids = aRows.map((r) => cell(r, 0));
    const both = ids.filter((id) => held.has(id) && scattered.has(id));
    const neither = ids.filter((id) => !held.has(id) && !scattered.has(id));
    const ghost = [...scattered].filter((id) => !ids.includes(id));
    if (both.length > 0) {
      fail(A.start, `#${both.join(' #')} 既挂在决策点上又列进「零散」——一条发现只能归一处`);
    }
    if (ghost.length > 0) {
      fail(A.start, `「零散」里写了 #${ghost.join(' #')}，A 表里没有这一条`);
    }
    if (neither.length > 0 && !sawScattered) {
      fail(
        A.start,
        `#${neither.join(' #')} 既没挂到决策点上，也没有一行「零散：#${neither.join(' #')}」——` +
          '每个编号都要交代：合进去了，还是零散',
      );
    }
    if (neither.length > 0 && sawScattered) {
      fail(A.start, `#${neither.join(' #')} 没有出现在任何决策点，也没列进「零散」——漏了一条`);
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
    const refs = new Set(dRows.map((r) => r.cells[0]));
    const has = (s) => [...refs].some((x) => x.includes(s));
    if (!has('adversarial.md')) notes.push('D 表没列 references/adversarial.md（代码与变更集的必载）');
    if (!has('code.md') && !has('diff.md')) notes.push('D 表没列 references/code.md 或 references/diff.md（按对象必载其一）');
    if (![...refs].some((x) => x.includes('/lang/'))) notes.push('D 表没列语言清单（认得出技术栈就必须列）');
  }
  notes.push('各表');

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
      // 数字对得上不等于条目对得上：A 表每条指的位置，账本里要有同一处。
      // 只认「路径:行号」这一种锚点，认不出锚点的行跳过——认不出不是错，是这一行没写位置。
      const target = candidates.find((q) => existsSync(q));
      const posCol = A === null ? -1 : A.header.indexOf('位置');
      if (target !== undefined && posCol >= 0) {
        const ledgerText = readFileSync(target, 'utf8').replace(/\\/g, '/');
        const missing = [];
        for (const r of A.rows) {
          const anchor = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)/.exec(String(r.cells[posCol] ?? '').replace(/\\/g, '/'));
          if (anchor === null) continue;
          if (!ledgerText.includes(`${anchor[1]}:${anchor[2]}`)) missing.push(`${anchor[1]}:${anchor[2]}`);
        }
        if (missing.length > 0) {
          fail(
            ledgerIdx + 1,
            `A 表这 ${missing.length} 条的位置在账本里找不到：${missing.slice(0, 4).join('、')}——报告与账本要能逐条对上，对不上的补进账本或从 A 表撤下`,
          );
        }
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
  const checkRe = /^校验\s*(?:通过|未通过：.+|未跑：.+)(?:（[^）]*）)?$/;
  if (checkIdx === -1) {
    fail(last?.line ?? null, '没有 `校验` 行——不写等于隐瞒');
  } else {
    if (checkIdx !== prevIdx) {
      fail(checkIdx + 1, '校验行必须在用量行正上方（倒数第二行），它紧挨用量行之上');
    }
    if (!checkRe.test(vis[checkIdx].trim())) {
      fail(checkIdx + 1, '校验行只有三种写法：`校验 通过`、`校验 未通过：<条目>`、`校验 未跑：<原因>`');
    }
    // 一条「严重」也没有时，读者分不清是"规则算出来的"还是"没往那儿看"——让作者对例外表个态。
    if (A !== null && /^校验\s*通过/.test(vis[checkIdx].trim())) {
      const lv = A.header.indexOf('级别');
      const sev = lv < 0 ? 0 : A.rows.filter((r) => (r.cells[lv] || '').trim() === '严重').length;
      if (sev === 0 && !/无严重级/.test(vis[checkIdx])) {
        notes.push(`A 表一条「严重」也没有（${checkIdx + 1} 行）——若是只读评审按规则算出来的，在校验行写一句「无严重级（例外未用：〈理由〉）」，让读者知道是规则不行，而不是没看`);
      }
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
    // 只认「像 HTML 标签」的：闭合标签，或后面不跟着冒号的开标签。
    // `<img>:1`、`<table>:5` 这类是占位符（磁盘镜像、表名），不是折叠块也不是内联样式。
    const htmlTag = /<(details|summary|div|span|br|img|table|style)(\s[^>]*)?>(?!:)|<\/(details|summary|div|span|br|img|table|style)>/i;
    if (htmlTag.test(vis[i])) fail(i + 1, '不许写 HTML（折叠块、内联样式都算）');
    // 槽位只认全角尖括号 `〈…〉`：程序里的 `<T>`、`Vec<u8>`、`<img>` 与它长得不一样，
    // 所以这里不需要"含中文才算槽位"那种猜测——一旦出现就是没填完。
    for (const m of vis[i].matchAll(/〈[^〈〉\n]{1,60}〉/g)) {
      fail(i + 1, `还有没填的槽位：${m[0]}（这是模板标记，交付前换成实际值）`);
    }
  }

  // ---- 禁句 ----
  // 只查表格数据行、提要行与收尾行；围栏代码块与行内代码里的字样不算（那可能是元讨论或输出）。
  const bannedLines = [];
  const softBanned = [];
  for (const t of tables) for (const r of t.rows) softBanned.push({ line: r.line, text: r.cells.join(' | ') });
  for (const q of quote) bannedLines.push({ line: q.line, text: q.text });
  const lastTableEnd = tables.reduce((mx, t) => Math.max(mx, t.endIdx), -1);
  const closeTo = prevIdx >= 0 ? prevIdx : lastIdx;
  for (let i = lastTableEnd + 1; i < closeTo; i++) {
    if (vis[i].trim() === '') continue;
    if (/^校验\s/.test(vis[i].trim())) continue;
    bannedLines.push({ line: i + 1, text: vis[i] });
  }
  const bannedHit = (text) => {
    const plain = stripCode(text);
    for (const phrase of BANNED) {
      // 「能合」是「不能合」「能合并」的子串：长词先命中即跳出，且排除「能合并」这种复合词。
      const hit = phrase === '能合' ? /(?<!不)能合(?!并)/.test(plain) : plain.includes(phrase);
      if (hit) return phrase;
    }
    return null;
  };
  for (const cand of bannedLines) {
    const phrase = bannedHit(cand.text);
    if (phrase !== null) {
      fail(cand.line, `出现了禁句「${phrase}」——format.md §六与提要规则明令禁止（审批词、完整性命题）`);
    }
  }
  // 表格里同一批词只作提示：「不能合并到一处」「没有问题域重叠」这类句子本身是正常判据用语。
  for (const cand of softBanned) {
    const phrase = bannedHit(cand.text);
    if (phrase !== null) notes.push(`第 ${cand.line} 行的表里有「${phrase}」——若是在说结论（而不是在说判据），改掉`);
  }

  // ---- 局限 ----
  // 交出去的问题：`待答` 是那一句问话，`症结` 是为什么难；两者只在 `未决` 存在时成立。
  const hasUndecided = /^未决：/m.test(text);
  const answerLine = /^待答：(.*)$/m.exec(text);
  if (/^症结：/m.test(text) && !hasUndecided) {
    fail(1, '写了 `症结：` 却没有 `未决：`——症结是给交出去的那一问做注脚的，没有那一问，它只是感想');
  }
  if (answerLine !== null) {
    if (!hasUndecided) fail(1, '写了 `待答：` 却没有 `未决：`——先写清卡在哪、已知什么、排除了什么，再问');
    if (!/[？?]|是否/.test(answerLine[1])) {
      fail(1, '`待答：` 那一行没有问号，也没有「是否」——它现在是结论，不是问题');
    }
  }

  // 「待查」不是级别，是一个交代：为什么判不了、缺什么、交给谁。没写这三样，等于把问题原样退回去。
  const uncertain = A === null ? [] : A.rows.filter((r) => cell(r, 1) === '待查');
  if (uncertain.length > 0 && !/^局限[：:]/m.test(text)) {
    notes.push(`A 表里 ${uncertain.length} 条「待查」，但没有 \`局限：\` 那一行——按 references/format.md 第四节，待查要写清是"没走到""判不了"还是"该你定"，以及补什么才能判`);
  }

  return { problems, notes };
}

// 命令行入口：被 import 时不跑（自测夹具就是这样复用它，不必起子进程）。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
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
      const tip = notes.length === 0 ? '' : `（${notes.length} 条提示：${notes.slice(0, 3).join('；')}${notes.length > 3 ? `……等 ${notes.length} 条；--strict 当错` : ''}）`;
      console.log(`OK   ${f}${tip}`);
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

