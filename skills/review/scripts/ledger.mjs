#!/usr/bin/env node
// 账本：定死列、校验、多本合并重编号。
//
// 用法：
//   node scripts/ledger.mjs check <账本.md> [...]
//   node scripts/ledger.mjs merge <输出.md> <账本.md> [...] [--no-dedupe]
//
// 只查能机械判真假的事：列数、词表、编号、依据与级别的相容、重复锚点、
// 跨文件重复。不判断一条发现对不对，也不读被审对象。
//
// 退出码：0 通过 / 1 有问题 / 2 用法或读取失败。

import fs from 'node:fs';
import path from 'node:path';

export const COLUMNS = ['#', '级别', '依据', '位置', '问题', '修法', '反方', '撤回条件'];
export const LEVELS = ['严重', '一般', '待查'];
export const BASES = ['跑了命令', '读源码', '引了原文', '推断'];
export const CONFIDENCE = ['可证', '一环未读全', '存疑'];

// 「严重」要有独立依据：真跑过的命令，或别人写的权威原文。
const HARD_BASES = ['跑了命令', '引了原文'];

const SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;
const ANCHOR = /`?([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?`?/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

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

function stripCode(s) {
  return s.replace(/`/g, '').trim();
}

/**
 * 解析一份账本。允许它由多段组成，每段以一个 `# 标题` 开头、
 * 后面跟一张固定列的表（表头在每段里重复出现）。
 */
export function parseLedger(text, file = '<ledger>') {
  const lines = text.split('\n');
  const sections = [];
  const problems = [];
  let section = null;

  const ensure = () => {
    if (section === null) {
      section = { title: '', startLine: 1, rows: [] };
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
      section = { title: line.replace(/^#{1,6}\s*/, '').trim(), startLine: no, rows: [] };
      sections.push(section);
      continue;
    }

    if (!line.startsWith('|')) {
      problems.push({ file, line: no, msg: `账本里出现了不属于任何表的文字：${line.slice(0, 40)}` });
      continue;
    }

    if (SEPARATOR.test(line)) continue;

    const cells = splitRow(raw);
    const head = cells[0].replace(/`/g, '');

    if (head === '#' && cells.includes('级别')) {
      const want = COLUMNS;
      const same = cells.length === want.length && cells.every((c, k) => stripCode(c) === want[k]);
      if (!same) {
        problems.push({
          file,
          line: no,
          msg: `表头必须是这八列且按此顺序：${want.join(' | ')}；实际是 ${cells.map(stripCode).join(' | ')}`,
        });
      }
      ensure();
      section.hasHeader = true;
      continue;
    }

    const sec = ensure();
    sec.rows.push({ file, line: no, cells });
  }

  return { file, sections, problems };
}

function parseBasis(cell, push) {
  const raw = stripCode(cell);
  const m = /^([^（(]+)(?:[（(]\s*([^）)]+?)\s*[）)])?$/.exec(raw);
  if (m === null) return { basis: raw, confidence: null };
  const basis = m[1].trim();
  const confidence = m[2] === undefined ? null : m[2].trim();
  if (!BASES.includes(basis)) {
    push(`依据只能是 ${BASES.join('／')}，实际写的是「${basis}」`);
  }
  if (confidence !== null && !CONFIDENCE.includes(confidence)) {
    push(`确认程度只能是 ${CONFIDENCE.join('／')}，实际写的是「${confidence}」`);
  }
  if (confidence !== null && basis === '推断') {
    push('推断这一档已经不声称掌握了事实，后面不必再跟确认程度');
  }
  return { basis, confidence };
}

/** 单行结构化；不合法也返回对象，问题记在 problems 里。 */
export function readRow(row, push, columnsExpected = COLUMNS) {
  if (row.cells.length !== columnsExpected.length) {
    push(`一行必须是 ${columnsExpected.length} 列，这一行是 ${row.cells.length} 列`);
    return null;
  }
  const [n, level, basisCell, loc, problem, fix, counter, retract] = row.cells.map((c) => c);
  const out = {
    file: row.file,
    line: row.line,
    n: Number(stripCode(n)),
    level: stripCode(level),
    basisCell: stripCode(basisCell),
    loc: stripCode(loc),
    problem: stripCode(problem),
    fix: stripCode(fix),
    counter: stripCode(counter),
    retract: stripCode(retract),
  };

  if (!Number.isInteger(out.n) || out.n <= 0) push(`第一列必须是正整数编号，实际是「${n}」`);
  if (!LEVELS.includes(out.level)) push(`级别只能是 ${LEVELS.join('／')}，实际是「${out.level}」`);

  const { basis, confidence } = parseBasis(basisCell, push);
  out.basis = basis;
  out.confidence = confidence;

  const anchor = ANCHOR.exec(out.loc);
  if (anchor === null) {
    push(`位置必须带 \`文件:行号\`，实际是「${out.loc}」`);
  } else {
    out.locPath = anchor[1];
    out.locFrom = Number(anchor[2]);
    out.locTo = anchor[3] === undefined ? Number(anchor[2]) : Number(anchor[3]);
    if (out.locTo < out.locFrom) push(`位置的行号范围反了：${out.locPath}:${out.locFrom}-${out.locTo}`);
  }

  for (const [key, label] of [
    ['problem', '问题'],
    ['fix', '修法'],
    ['counter', '反方'],
    ['retract', '撤回条件'],
  ]) {
    if (out[key] === '' || out[key] === '-') push(`${label}这一列不能空`);
  }

  if (out.level === '严重' && !HARD_BASES.includes(out.basis)) {
    push('「严重」要有独立依据（跑了命令或引了原文）；这一条的依据是「' + out.basis + '」');
  }
  if (out.retract === '无') {
    push('撤回条件写「无」，等于说这条不可证伪；写清什么情况会让它不成立');
  }
  if (EMOJI.test(row.cells.join('|'))) push('账本里不用图标（含 emoji）');

  return out;
}

export function validateFile(text, file = '<ledger>') {
  const parsed = parseLedger(text, file);
  const problems = [...parsed.problems];
  const notes = [];
  const rows = [];

  for (const section of parsed.sections) {
    const push = (msg) => problems.push({ file, line: section.rows[0]?.line ?? section.startLine, msg });
    if (section.rows.length > 0 && section.hasHeader !== true) {
      problems.push({ file, line: section.startLine, msg: '这一段缺表头：每段开头要写 `# <路号> · <主责范围>`，然后是八列表头' });
    }
    let expected = 1;
    for (const row of section.rows) {
      const problemsBefore = problems.length;
      const push2 = (msg) => problems.push({ file, line: row.line, msg });
      const parsedRow = readRow(row, push2);
      if (parsedRow === null) continue;
      if (parsedRow.n !== expected) {
        problems.push({ file, line: row.line, msg: `编号应当连续，这一行是 ${parsedRow.n}，按位置应当是 ${expected}` });
      }
      expected = parsedRow.n + 1;
      rows.push({ ...parsedRow, section: section.title });
      if (problems.length > problemsBefore) continue;
    }
  }

  // 同一本内重复锚点：完全相同的（位置 + 问题）＝自相重复；（位置相同、问题不同）＝提示合并。
  const seen = new Map();
  for (const row of rows) {
    const key = `${row.locPath}:${row.locFrom}`;
    const prev = seen.get(key);
    if (prev === undefined) {
      seen.set(key, row);
      continue;
    }
    if (prev.problem === row.problem) {
      problems.push({
        file: row.file,
        line: row.line,
        msg: `与第 ${prev.line} 行重复：同一个位置、同一句话（${key}）`,
      });
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

  for (const input of inputs) {
    const result = validateFile(input.text, input.file);
    problems.push(...result.problems);
    notes.push(...result.notes);
    const rows = [];
    const bySection = new Map();
    for (const row of result.rows) {
      const section = row.section || input.file;
      if (!bySection.has(section)) bySection.set(section, []);
      bySection.get(section).push(row);
    }
    for (const [title, list] of bySection) {
      rows.push({ title, rows: list });
    }
    blocks.push({ file: input.file, sections: rows });
  }

  const out = [];
  for (const block of blocks) {
    for (const section of block.sections) {
      const kept = [];
      for (const row of section.rows) {
        const key = `${row.locPath}:${row.locFrom}|${row.problem}`;
        if (dedupe && seen.has(key)) {
          notes.push({ file: row.file, line: row.line, msg: `合并时去掉一条重复：${row.locPath}:${row.locFrom}` });
          continue;
        }
        seen.add(key);
        n += 1;
        kept.push({ ...row, n });
      }
      if (kept.length === 0) continue;
      out.push(`# ${section.title}`);
      out.push('');
      out.push(`| ${COLUMNS.join(' | ')} |`);
      out.push(`|${COLUMNS.map(() => '---').join('|')}|`);
      for (const row of kept) {
        out.push(
          `| ${row.n} | ${row.level} | ${row.basisCell} | \`${row.locPath}:${row.locFrom}${
            row.locTo !== row.locFrom ? `-${row.locTo}` : ''
          }\` | ${row.problem} | ${row.fix} | ${row.counter} | ${row.retract} |`,
        );
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

账本每段以 "# <路号> · <主责范围>" 开头，随后是八列表：
  ${COLUMNS.join(' | ')}
只查能机械判真假的事；不判断一条发现对不对，也不读被审对象。`);
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
      } catch (error) {
        console.error(`读不了 ${file}：${error.message}`);
        return 2;
      }
      const result = validateFile(text, file);
      total += result.rows.length;
      for (const p of result.problems) {
        console.log(`不通过 ${p.file}:${p.line} ${p.msg}`);
        bad += 1;
      }
      for (const note of result.notes) console.log(`提示 ${note.file}:${note.line} ${note.msg}`);
    }
    console.log(`账本 ${files.length} 本 · ${total} 条 · 不通过 ${bad} 项`);
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
      } catch (error) {
        console.error(`读不了 ${file}：${error.message}`);
        return 2;
      }
    }
    const result = mergeLedgers(inputs, { dedupe });
    if (result.problems.length > 0) {
      for (const p of result.problems) console.log(`不通过 ${p.file}:${p.line} ${p.msg}`);
      console.log(`合并没有写盘：源账本本身有 ${result.problems.length} 项不通过，先修再合`);
      return 1;
    }
    fs.writeFileSync(outFile, result.text);
    for (const note of result.notes) console.log(`提示 ${note.file}:${note.line} ${note.msg}`);
    console.log(`已合并 ${files.length} 本 → ${outFile} · ${result.total} 条`);
    return 0;
  }

  usage();
  return 2;
}

if (process.argv[1] !== undefined) {
  const self = path.resolve(process.argv[1]);
  const here = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  if (self === here) {
    process.exitCode = main(process.argv);
  }
}
