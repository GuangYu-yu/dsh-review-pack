#!/usr/bin/env node
// 账本：按表头认列、校验、多本合并重编号。
//
// 用法：
//   node scripts/ledger.mjs check <账本.md> [...]
//   node scripts/ledger.mjs merge <输出.md> <账本.md> [...] [--no-dedupe]
//
// 只认一件必需的事：表里要有「位置」列（脚本靠它回源）。其余列叫什么都行、
// 有几列都行、顺序随意、编号可有可无。它只查能机械判真假的事：列数与表头对上、
// 位置带 `文件:行号`、同位置重复。不判断一条发现对不对，也不读被审对象。
//
// 退出码：0 通过 / 1 有问题 / 2 用法或读取失败。

import fs from 'node:fs';
import path from 'node:path';

// 只是一份示例表头（`usage` 里给人看）。账本按自己的表头来，不必照抄这八列。
export const COLUMNS = ['#', '级别', '依据', '位置', '问题', '修法', '反方', '撤回条件'];
export const REQUIRED_COLUMN = '位置';

const SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;
const ANCHOR = /`?([A-Za-z0-9_./\\:-]*\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?`?/;

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function esc(s) {
  return String(s).replace(/\|/g, '\\|');
}

function stripCode(s) {
  return s.replace(/`/g, '').trim();
}

/**
 * 解析一份账本。允许它由多段组成，每段以一个 `# 标题` 开头、后面跟一张表；
 * 表头在每段里重复出现，列名由写的人定，但必须有「位置」。
 */
export function parseLedger(text, file = '<ledger>') {
  const lines = text.split('\n');
  const sections = [];
  const problems = [];
  let section = null;

  const ensure = () => {
    if (section === null) {
      section = { title: '', startLine: 1, rows: [], columns: null, hasHeader: false };
      sections.push(section);
    }
    return section;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const no = i + 1;

    if (line === '') continue;

    if (/^#{1,6}\s/.test(line)) {
      section = { title: line.replace(/^#{1,6}\s*/, '').trim(), startLine: no, rows: [], columns: null, hasHeader: false };
      sections.push(section);
      continue;
    }

    if (SEPARATOR.test(line)) continue;

    if (!line.startsWith('|')) {
      problems.push({ file, line: no, msg: `账本里出现了不属于任何表的文字：${line.slice(0, 40)}` });
      continue;
    }

    const cells = splitRow(raw).map(stripCode);
    const sec = ensure();

    // 表头：任意一列叫「位置」。认出来后这一段按这些列名解析。
    if (!sec.hasHeader && cells.includes(REQUIRED_COLUMN)) {
      sec.hasHeader = true;
      sec.columns = cells;
      if (new Set(cells).size !== cells.length) {
        problems.push({ file, line: no, msg: `表头里有重名的列：${cells.join(' | ')}` });
      }
      continue;
    }

    sec.rows.push({ file, line: no, cells });
  }

  return { file, sections, problems };
}

/** 单行结构化；不合法也返回对象，问题记在 problems 里。 */
export function readRow(row, push, columns) {
  if (row.cells.length !== columns.length) {
    push(`一行必须是 ${columns.length} 列（与表头 ${columns.join(' | ')} 对齐），这一行是 ${row.cells.length} 列——正文里的竖线要写成 \\|（Rust 闭包 |e|、|| 、位或都算）`);
    return null;
  }
  const values = new Map();
  columns.forEach((name, i) => values.set(name, row.cells[i]));
  const get = (name) => (values.has(name) ? stripCode(values.get(name)) : null);

  const out = { file: row.file, line: row.line, value: (name) => get(name), values };

  const n = get('#');
  if (n !== null) {
    out.n = Number(n);
    if (!Number.isInteger(out.n) || out.n <= 0) push(`编号列必须是正整数，实际是「${n}」`);
  }

  const level = get('级别');
  if (level !== null && level === '') push('轻重的列空着——写清后果有多重，词你自己定');

  const loc = get(REQUIRED_COLUMN) ?? '';
  out.loc = loc;

  // 槽位（`〈…〉`）是模板标记：账本是要交的，位置里留着它说明模板没填完。
  if (/〈[^〈〉\n]{1,60}〉/.test(loc)) {
    push(`位置里还有没填的槽位（模板不是交付物）：${loc}`);
  } else {
    const anchor = ANCHOR.exec(loc);
    if (anchor === null) {
      push(`位置必须带 \`文件:行号\`，实际是「${loc}」`);
    } else {
      out.locPath = anchor[1];
      out.locFrom = Number(anchor[2]);
      out.locTo = anchor[3] === undefined ? Number(anchor[2]) : Number(anchor[3]);
      if (out.locTo < out.locFrom) push(`位置的行号范围反了：${out.locPath}:${out.locFrom}-${out.locTo}`);
    }
  }

  for (const label of ['问题', '修法', '反方', '撤回条件']) {
    const v = get(label);
    if (v !== null && v === '') push(`「${label}」这一列空着——这一列既然有，就别留空`);
  }
  const retract = get('撤回条件');
  if (retract === '无') {
    push('撤回条件写「无」，等于说这条不可证伪；写清什么情况会让它不成立');
  }

  return out;
}

export function validateFile(text, file = '<ledger>') {
  const parsed = parseLedger(text, file);
  const problems = [...parsed.problems];
  const notes = [];
  const rows = [];

  for (const section of parsed.sections) {
    if (section.rows.length > 0 && section.hasHeader !== true) {
      problems.push({
        file,
        line: section.startLine,
        msg: `这一段缺表头：表的第一行要写列名，其中必须有「${REQUIRED_COLUMN}」`,
      });
      continue;
    }
    if (section.hasHeader && !section.columns.includes(REQUIRED_COLUMN)) {
      problems.push({
        file,
        line: section.startLine,
        msg: `表头里没有「${REQUIRED_COLUMN}」列——脚本靠它回源；表头是 ${section.columns.join(' | ')}`,
      });
      continue;
    }

    const columns = section.columns ?? [];
    const numbered = columns.includes('#');
    let expected = 1;
    for (const row of section.rows) {
      const push = (msg) => problems.push({ file, line: row.line, msg });
      const parsedRow = readRow(row, push, columns);
      if (parsedRow === null) continue;
      if (numbered) {
        if (parsedRow.n !== expected) {
          problems.push({ file, line: row.line, msg: `编号应当连续，这一行是 ${parsedRow.n}，按位置应当是 ${expected}` });
        }
        expected = (Number.isInteger(parsedRow.n) ? parsedRow.n : expected) + 1;
      } else {
        parsedRow.n = expected;
        expected += 1;
      }
      rows.push({ ...parsedRow, section: section.title, columns });
    }
  }

  // 同一本内重复锚点：完全相同的（位置 + 问题）＝自相重复；（位置相同、问题不同）＝提示合并。
  const seen = new Map();
  for (const row of rows) {
    if (row.locPath === undefined) continue;
    const key = `${row.locPath}:${row.locFrom}`;
    const prev = seen.get(key);
    if (prev === undefined) {
      seen.set(key, row);
      continue;
    }
    if (prev.value('问题') === row.value('问题')) {
      problems.push({ file: row.file, line: row.line, msg: `与第 ${prev.line} 行重复：同一个位置、同一句话（${key}）` });
    } else {
      notes.push({ file: row.file, line: row.line, msg: `同一位置在第 ${prev.line} 行还有一条不同表述，可能需要合并（${key}）` });
    }
  }

  return { file, rows, problems, notes };
}

export function mergeLedgers(inputs, { dedupe = true } = {}) {
  const blocks = [];
  const problems = [];
  const notes = [];
  const seen = new Set();
  let n = 0;

  // 合并后的表头：写的人用过的列名，按第一次出现的顺序；`#` 排在最前。
  const order = [];
  const remember = (name) => {
    if (name !== '#' && !order.includes(name)) order.push(name);
  };

  for (const input of inputs) {
    const result = validateFile(input.text, input.file);
    problems.push(...result.problems);
    notes.push(...result.notes);
    const bySection = new Map();
    for (const row of result.rows) {
      for (const c of row.columns) remember(c);
      const section = row.section || input.file;
      if (!bySection.has(section)) bySection.set(section, []);
      bySection.get(section).push(row);
    }
    blocks.push({ file: input.file, sections: [...bySection] });
  }

  if (!order.includes(REQUIRED_COLUMN)) order.unshift(REQUIRED_COLUMN);
  const header = ['#', ...order];

  const out = [];
  for (const block of blocks) {
    for (const [title, list] of block.sections) {
      const kept = [];
      for (const row of list) {
        const key = `${row.locPath}:${row.locFrom}|${row.value('问题') ?? ''}|${row.value('级别') ?? ''}|${row.value('依据') ?? ''}`;
        if (dedupe && seen.has(key)) {
          notes.push({ file: row.file, line: row.line, msg: `合并时去掉一条重复：${row.locPath}:${row.locFrom}` });
          continue;
        }
        seen.add(key);
        n += 1;
        kept.push({ row, n });
      }
      if (kept.length === 0) continue;
      out.push(`# ${title}`);
      out.push('');
      out.push(`| ${header.join(' | ')} |`);
      out.push(`|${header.map(() => '---').join('|')}|`);
      // 段内编号从 1 起：合出来的每一段都要能被 check 原样接受。
      let k = 0;
      for (const { row } of kept) {
        k += 1;
        const no = k;
        const cells = header.map((name) => {
          if (name === '#') return String(no);
          if (name === REQUIRED_COLUMN) {
            return `\`${row.locPath}:${row.locFrom}${row.locTo !== row.locFrom ? `-${row.locTo}` : ''}\``;
          }
          return esc(row.value(name) ?? '');
        });
        out.push(`| ${cells.join(' | ')} |`);
      }
      out.push('');
    }
  }

  return { text: out.join('\n').trimEnd() + '\n', total: n, problems, notes };
}

function usage() {
  console.error(`用法：
  node scripts/ledger.mjs check <账本.md> [...]
  node scripts/ledger.mjs merge <输出.md> <账本.md> [...] [--no-dedupe]

账本是一张或几张表，表头你自己定，但**必须有一列叫「${REQUIRED_COLUMN}」**，
里面写 \`文件:行号\`。其余列可有可无、叫什么都行、顺序随意，编号列也可省。
下面只是一份常见写法，不必照抄：
  ${COLUMNS.join(' | ')}

它只查能机械判真假的事；不判断一条发现对不对，也不读被审对象。`);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    usage();
    return 2;
  }
  const dedupe = !args.includes('--no-dedupe');
  const rest = args.filter((a) => a !== '--no-dedupe');

  if (rest[0] === 'check') {
    const files = rest.slice(1);
    if (files.length === 0) {
      usage();
      return 2;
    }
    let bad = 0;
    let total = 0;
    for (const file of files) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        console.error(`读不到：${file}`);
        bad += 1;
        continue;
      }
      const result = validateFile(text, file);
      total += result.rows.length;
      for (const p of result.problems) console.log(`FAIL ${p.file}:${p.line} ${p.msg}`);
      for (const p of result.notes) console.log(`NOTE ${p.file}:${p.line} ${p.msg}`);
      if (result.problems.length === 0) console.log(`OK   ${file}（${result.rows.length} 条）`);
      else bad += 1;
    }
    console.log(`合计 ${total} 条${bad === 0 ? '，没有发现问题' : `，${bad} 份不通过`}`);
    return bad === 0 ? 0 : 1;
  }

  if (rest[0] === 'merge') {
    const [outFile, ...files] = rest.slice(1);
    if (outFile === undefined || files.length === 0) {
      usage();
      return 2;
    }
    const inputs = [];
    for (const file of files) {
      try {
        inputs.push({ file, text: fs.readFileSync(file, 'utf8') });
      } catch {
        console.error(`读不到：${file}`);
        return 2;
      }
    }
    const result = mergeLedgers(inputs, { dedupe });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, result.text);
    for (const p of result.problems) console.log(`FAIL ${p.file}:${p.line} ${p.msg}`);
    for (const p of result.notes) console.log(`NOTE ${p.file}:${p.line} ${p.msg}`);
    console.log(`合并完成：${outFile}（${result.total} 条）`);
    return result.problems.length === 0 ? 0 : 1;
  }

  usage();
  return 2;
}

const invoked = process.argv[1] !== undefined;
const self = decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
if (invoked && path.resolve(process.argv[1]) === path.resolve(self)) {
  process.exitCode = main(process.argv);
}
