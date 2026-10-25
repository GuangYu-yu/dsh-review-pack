#!/usr/bin/env node
// 锚点与引文核验：把报告或账本里写下的 `文件:行号` 与反引号引文，
// 拿去实际文件里对一遍。
//
// 用法：
//   node scripts/verify-quotes.mjs <报告.md|账本.md> [...] [--root <目录>] [--window 3] [--strict] [--json]
//
// 硬结论只有两条：文件在不在、行号越没越界。
// 「引文不在这里」只作提示——一句话可以在文件另一处、也可能是作者自己的
// 示例或转述，工具分不出来。加 --strict 才把它当失败。
//
// 退出码：0 没发现问题 / 1 有 / 2 用法或读取失败。

import fs from 'node:fs';
import path from 'node:path';

const ANCHOR = /`?([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?`?/g;
const BACKTICK = /`([^`\n]+)`/g;
const CODEISH = /[(){}[\]=;:<>!&|]|\s/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_:]*$/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.release', 'target', '.next', 'vendor']);

// 这些是包自己的词，被反引号括起来时不是引文。
const VOCAB = new Set([
  '严重', '一般', '待查', '跑了命令', '读源码', '引了原文', '推断',
  '可证', '一环未读全', '存疑', '账本', 'A 表', 'B 表', 'C 表', 'D 表',
]);

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

/** 从一段文本里取出「位置 → 引文」的配对。报告与账本用同一套读法。 */
export function collect(text, file = '<input>') {
  const lines = text.split('\n');
  const targets = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = raw.trim();
    if (line === '') continue;

    const cells = line.startsWith('|') ? splitRow(raw) : [line];
    // 槽位是模板标记，不是引用：含 `〈…〉` 的单元格整格跳过——既不算锚点，也不算引文。
    const usable = cells.filter((c) => !c.includes('〈'));
    if (usable.length === 0) continue;
    const anchors = [];
    for (const cell of usable) {
      for (const m of cell.matchAll(ANCHOR)) {
        anchors.push({ path: m[1], from: Number(m[2]), to: m[3] === undefined ? Number(m[2]) : Number(m[3]) });
      }
    }
    if (anchors.length === 0) continue;

    const quotes = [];
    for (const cell of usable) {
      for (const m of cell.matchAll(BACKTICK)) {
        const span = m[1].trim();
        if (span.length < 6) continue;
        if (VOCAB.has(span)) continue;
        if (span.includes('〈')) continue; // 槽位模板，不是原文
        if (/^[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+:\d+/.test(span)) continue; // 本身就是位置
        if (!CODEISH.test(span) && !IDENT.test(span)) continue;
        if (EMOJI.test(span)) continue;
        if (CJK.test(span)) continue; // 中文是论述，不是原文
        if (/^[-#:]/.test(span)) continue; // 命令行选项、条目号、行号区间
        // 多词的自然语句（英文说明）不是引文；带代码符号的才算。
        if (!/[(){}\[\];=<>!&|]/.test(span) && span.split(/\s+/).length >= 4) continue;
        quotes.push({ text: span, kind: looksVerbatim(span) ? 'excerpt' : 'mention' });
      }
    }

    const seen = new Set();
    for (const anchor of anchors) {
      for (const quote of quotes) {
        const key = `${anchor.path}:${anchor.from}|${quote.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ file, line: i + 1, anchor, quote: quote.text, kind: quote.kind });
      }
      if (quotes.length === 0) targets.push({ file, line: i + 1, anchor, quote: null, kind: null });
    }
  }

  return targets;
}

/** 根下所有文件（跳过依赖与产物目录），按需走一次。 */
function walkFiles(root, walkCache) {
  if (walkCache.files !== null) return walkCache.files;
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs, depth + 1);
      } else if (entry.isFile()) {
        files.push(abs);
      }
    }
  };
  walk(root, 0);
  walkCache.files = files;
  return files;
}

/** 相对路径按根解析；找不到就按后缀在根下搜一次（报告常省掉前缀）。 */
function resolveFile(root, rel, walkCache) {
  const direct = path.isAbsolute(rel) ? rel : path.resolve(root, rel);
  if (fs.existsSync(direct)) return { abs: direct, how: 'direct' };

  const needle = rel.replace(/\\/g, '/');
  const hits = walkFiles(root, walkCache).filter((abs) => abs.replace(/\\/g, '/').endsWith('/' + needle));
  if (hits.length === 0) return { abs: null, how: 'missing', hits };
  hits.sort((a, b) => a.length - b.length);
  return { abs: hits[0], how: 'suffix', hits };
}

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/;const STATEMENT = /^(if|else|for|while|return|let|fn|pub|impl|struct|enum|match|use|mod|const|static|type|loop|await)\b/;

/** 只有像"从源文件里抄下来的一段"的写法才逐字核；名字与短表达式只查在不在。 */
function looksVerbatim(span) {
  if (STATEMENT.test(span)) return true;
  if (/;\s*$/.test(span)) return true;
  return /\s/.test(span) && /\([^)]*\)/.test(span);
}

/** 归一：压空白、去掉括号与逗号分号两侧的空格。同一个表达换行或加空格后仍能对上。 */
function normalize(text) {
  return text
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}()[\],;:<>])\s*/g, '$1')
    .trim();
}

function lineOfIndex(normLines, index) {
  let acc = 0;
  for (let i = 0; i < normLines.length; i++) {
    acc += normLines[i].length + 1;
    if (index < acc) return i + 1;
  }
  return normLines.length;
}

function findQuote(normLines, joined, quote, from, to, window) {
  const needle = normalize(quote);
  if (needle === '') return { where: 'missing', line: null };
  const lo = Math.max(0, from - 1 - window);
  const hi = Math.min(normLines.length - 1, to - 1 + window);

  for (let i = lo; i <= hi; i++) {
    if (normLines[i].includes(needle)) return { where: 'near', line: i + 1 };
    if (i + 1 <= hi && `${normLines[i]} ${normLines[i + 1]}`.includes(needle)) return { where: 'near', line: i + 1 };
  }
  const at = joined.indexOf(needle);
  if (at >= 0) return { where: 'elsewhere', line: lineOfIndex(normLines, at) };
  return { where: 'missing', line: null };
}

const CORPUS_BY_ROOT = new Map();

/** 整个被审对象归一后的正文，用来判断一个名字/表达式到底存不存在。按需拼一次。 */
function buildCorpus(root, walkCache, corpusCache) {
  if (corpusCache.text !== null) return corpusCache.text;
  if (CORPUS_BY_ROOT.has(root)) {
    corpusCache.text = CORPUS_BY_ROOT.get(root);
    return corpusCache.text;
  }
  const parts = [];
  let size = 0;
  const SKIP_EXT = /\.(md|markdown|png|jpe?g|gif|webp|bmp|ico|zip|tgz|gz|bz2|xz|7z|pdf|woff2?|ttf|otf|exe|dll|so|dylib|rlib|o|a|class|jar|bin|dat|db|sqlite|mp4|webm|mov|iso|img)$/i;
  for (const abs of walkFiles(root, walkCache)) {
    if (size > 32 * 1024 * 1024) break;
    if (SKIP_EXT.test(abs)) continue;
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.size > 2 * 1024 * 1024) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    size += text.length;
    parts.push(normalize(text));
  }
  corpusCache.text = parts.join('\n');
  CORPUS_BY_ROOT.set(root, corpusCache.text);
  return corpusCache.text;
}

export function verify(text, { file = '<input>', root = process.cwd(), window = 3 } = {}) {
  const targets = collect(text, file);
  const cache = new Map();
  const walkCache = { files: null };
  const problems = [];
  const advisories = [];
  const notes = [];
  const corpusCache = { text: null };
  let anchorsChecked = 0;
  let quotesChecked = 0;

  for (const target of targets) {
    const { anchor, quote } = target;
    const resolved = resolveFile(root, anchor.path, walkCache);
    if (resolved.abs === null) {
      problems.push({ ...target, code: 'ANCHOR_FILE_MISSING', msg: `文件找不到：${anchor.path}（根：${root}）` });
      continue;
    }
    if (resolved.how === 'suffix') {
      notes.push({ file, line: target.line, msg: `${anchor.path} 按后缀解析到 ${path.relative(root, resolved.abs)}` });
      if (resolved.hits.length > 1) {
        notes.push({
          file,
          line: target.line,
          msg: `${anchor.path} 有 ${resolved.hits.length} 份同名文件，按后缀取最短的一份（${path.relative(root, resolved.abs)}）——请把路径补全，否则可能核到另一个文件`,
        });
      }
    }

    let lines;
    if (!cache.has(resolved.abs)) {
      const raw = fs.readFileSync(resolved.abs, 'utf8');
      const split = raw.split('\n');
      const normLines = split.map(normalize);
      cache.set(resolved.abs, { split, normLines, joined: normLines.join('\n') });
    }
    const cached = cache.get(resolved.abs);
    lines = cached.split;

    const total = lines.length;
    if (anchor.from < 1 || anchor.from > total) {
      problems.push({
        ...target,
        code: 'ANCHOR_LINE_OUT_OF_RANGE',
        msg: `${anchor.path} 只有 ${total} 行，引用的是第 ${anchor.from} 行`,
      });
      continue;
    }
    anchorsChecked += 1;
    if (quote === null) continue;

    quotesChecked += 1;

    // 名字与短表达式不是"引文"：只查它在整个被审对象里有没有出现过。
    // 报告里点名一个函数、常量、类型名是正常的，它们在别的文件里定义；
    // 只有全对象都找不到时，才可能是编出来的。
    if (target.kind === 'mention') {
      const needle = normalize(quote);
      if (cached.joined.includes(needle)) continue;
      if (buildCorpus(root, walkCache, corpusCache).includes(needle)) continue;
      advisories.push({
        ...target,
        code: 'NAME_NOT_FOUND',
        msg: `整个被审对象里都找不到：\`${quote.slice(0, 60)}\`——拼错，或这个标识符不存在`,
      });
      continue;
    }

    const found = findQuote(cached.normLines, cached.joined, quote, anchor.from, anchor.to, window);
    if (found.where === 'near') continue;
    if (found.where === 'elsewhere') {
      advisories.push({
        ...target,
        code: 'QUOTE_ELSEWHERE',
        msg: `引文在 ${anchor.path} 第 ${found.line} 行，不在锚点 ${anchor.from} 行附近（±${window} 行）——核对锚点，或说明这是另一处的对照`,
      });
      continue;
    }
    advisories.push({
      ...target,
      code: 'QUOTE_NOT_FOUND',
      msg: `引文在 ${anchor.path} 全文找不到：\`${quote.slice(0, 60)}\`——可能是转述、示例，也可能是编的`,
    });
  }

  if (targets.length === 0) {
    notes.push({ file, line: 1, msg: '没有找到任何 `文件:行号` 锚点——这份东西引用不了，也就核不了' });
  }

  return { problems, advisories, notes, anchorsChecked, quotesChecked, targets: targets.length };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.error(`用法：
  node scripts/verify-quotes.mjs <报告.md|账本.md> [...] [--root <目录>] [--window 3] [--strict] [--json]

把每一项 \`文件:行号\` 与实际文件对一遍；路径写短了（省掉 src/ 前缀）按后缀再找一次。
同一行的反引号引文会在锚点 ±window 行内逐字找：
  找不到、或只在别处 → 提示（可能是转述、示例，也可能是编的）
  --strict 才把它当失败。
不判断引文能否支持结论——那是人的事。`);
    return 2;
  }

  let root = process.cwd();
  let window = 3;
  let strict = false;
  let json = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--strict') strict = true;
    else if (a === '--root') root = path.resolve(args[++i]);
    else if (a === '--window') window = Number(args[++i]);
    else files.push(a);
  }
  if (files.length === 0 || !Number.isInteger(window) || window < 0) {
    console.error('参数不完整：至少给一个文件，--window 要是非负整数');
    return 2;
  }

  const all = { problems: [], advisories: [], notes: [], anchorsChecked: 0, quotesChecked: 0 };
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      console.error(`读不了 ${file}：${error.message}`);
      return 2;
    }
    const result = verify(text, { file, root, window });
    all.problems.push(...result.problems);
    all.advisories.push(...result.advisories);
    all.notes.push(...result.notes);
    all.anchorsChecked += result.anchorsChecked;
    all.quotesChecked += result.quotesChecked;
  }

  const failed = all.problems.length + (strict ? all.advisories.length : 0);

  if (json) {
    console.log(JSON.stringify(all, null, 2));
  } else {
    for (const p of all.problems) console.log(`不通过 ${p.file}:${p.line} [${p.code}] ${p.msg}`);
    for (const a of all.advisories) console.log(`提示 ${a.file}:${a.line} [${a.code}] ${a.msg}`);
    for (const note of all.notes) console.log(`说明 ${note.file}:${note.line} ${note.msg}`);
    console.log(
      `锚点 ${all.anchorsChecked} 处 · 引文 ${all.quotesChecked} 条 · 不通过 ${all.problems.length} 项 · 提示 ${all.advisories.length} 项（只核位置与原文，不判结论）`,
    );
  }
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined) {
  const self = path.resolve(process.argv[1]);
  const here = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  if (self === here) process.exitCode = main(process.argv);
}
