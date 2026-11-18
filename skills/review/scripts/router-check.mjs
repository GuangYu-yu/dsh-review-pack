#!/usr/bin/env node
// 路由检查：核派活清单与转交单是不是同一批路，以及窗口有没有把内容带出来。
//
// 用法：
//   node scripts/router-check.mjs <派活清单.md> <转交单.md>
//
// 派活清单要有这四列：id | 派活单 | sha256 | 账本
// 转交单要有这三列：  id | 账本 | 状态
//
// 它只判能机械判真假的事：两份件的 id 集合是不是同一批、每个 id 是不是只出现
// 一次、派活单还是不是发出去时那一份、标了已交回的账本在不在盘上、转交单里
// 有没有夹带内容。不判断任何一条发现对不对，也不读被审对象。行数与覆盖不归
// 路由管——它一读账本就把内容看进去了，那些留给合并账本的那一环。
//
// 路径怎么解析：相对路径按「派活清单所在目录」算，两份件共用这一个根。
//
// 退出码：0 通过 / 1 有问题 / 2 用法或读取失败。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { installRunLog } from './run-log.mjs';

export const MANIFEST_COLUMNS = ['id', '派活单', 'sha256', '账本'];
export const TRANSFER_COLUMNS = ['id', '账本', '状态'];
export const STATES = ['已交回', '未交回'];

const SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;
const MAX_CELL = 120;

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

function cleanHeader(cell) {
  return cell.replace(/\x60/g, '').trim();
}

// 从任意 markdown 里取出第一张表：表头行 + 数据行。找不到返回 null。
export function parseTable(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].trim().startsWith('|') || !SEPARATOR.test(lines[i + 1].trim())) continue;
    const header = splitRow(lines[i]).map(cleanHeader);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) break;
      if (!t.startsWith('|')) break;
      if (SEPARATOR.test(t)) break;
      rows.push(splitRow(t));
    }
    return { header, rows, start: i };
  }
  return null;
}

function requireColumns(table, required, label, problems) {
  if (!table) {
    problems.push(label + '：找不到表格（第一张表的表头行下面要紧跟分隔行）');
    return false;
  }
  const missing = required.filter((c) => !table.header.includes(c));
  if (missing.length) {
    problems.push(label + '：表头缺列 ' + missing.join('、') + '（读到的是：' + table.header.join('、') + '）');
    return false;
  }
  return true;
}

export function cellOf(row, header, name) {
  const i = header.indexOf(name);
  return i < 0 ? '' : (row[i] ?? '').trim();
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 转交单只许有：表格行、空行、一个 # 开头的标题。多出来的任何一行都是内容。
function checkNoContent(text, problems) {
  const lines = text.split(/\r?\n/);
  let inTable = false;
  let tableDone = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('|')) {
      if (tableDone) problems.push('转交单：表格第 ' + (i + 1) + ' 行在表格结束后又出现');
      inTable = true;
      continue;
    }
    if (t.startsWith('#')) continue;
    if (inTable) tableDone = true;
    problems.push('转交单第 ' + (i + 1) + ' 行有表格之外的文字：' + t.slice(0, 40));
  }
  if (text.includes('\x60')) problems.push('转交单里出现反引号：代码或锚点都不该经路由转手');
  if (/:\d/.test(text)) problems.push('转交单里出现冒号加数字（形如 文件:行号）：这属于内容，不属于路由');
  for (const m of text.matchAll(/\|([^|\n]*)\|/g)) {
    const cell = m[1].trim();
    if (cell.length > MAX_CELL) {
      problems.push('转交单单元格超过 ' + MAX_CELL + ' 字符：' + cell.slice(0, 30) + '…');
      break;
    }
  }
}

export function checkRouter(manifestPath, transferPath) {
  const problems = [];
  const notes = [];
  const manifestDir = path.dirname(path.resolve(manifestPath));
  const resolve = (p) => path.resolve(manifestDir, p);

  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const transferText = fs.readFileSync(transferPath, 'utf8');
  const manifest = parseTable(manifestText);
  const transfer = parseTable(transferText);

  if (!requireColumns(manifest, MANIFEST_COLUMNS, '派活清单', problems)) return { ok: false, problems, notes };
  if (!requireColumns(transfer, TRANSFER_COLUMNS, '转交单', problems)) return { ok: false, problems, notes };

  const jobs = manifest.rows.map((row) => ({
    id: cellOf(row, manifest.header, 'id'),
    brief: cellOf(row, manifest.header, '派活单'),
    sha: cellOf(row, manifest.header, 'sha256').toLowerCase(),
    ledger: cellOf(row, manifest.header, '账本'),
  }));
  const items = transfer.rows.map((row) => ({
    id: cellOf(row, transfer.header, 'id'),
    ledger: cellOf(row, transfer.header, '账本'),
    state: cellOf(row, transfer.header, '状态'),
  }));

  const seen = new Set();
  for (const job of jobs) {
    if (!job.id) problems.push('派活清单有空 id 的行');
    else if (seen.has(job.id)) problems.push('派活清单里 ' + job.id + ' 出现了不止一次');
    seen.add(job.id);
  }
  const seenT = new Set();
  for (const item of items) {
    if (!item.id) problems.push('转交单有空 id 的行');
    else if (seenT.has(item.id)) problems.push('转交单里 ' + item.id + ' 出现了不止一次');
    seenT.add(item.id);
  }
  for (const id of seen) if (!seenT.has(id)) problems.push('转交单少了 ' + id);
  for (const id of seenT) if (!seen.has(id)) problems.push('转交单多了 ' + id + '（派活清单里没有）');

  const briefSeen = new Set();
  const ledgerSeen = new Set();
  for (const job of jobs) {
    if (!job.brief) { problems.push(job.id + '：没写派活单路径'); continue; }
    if (!job.ledger) { problems.push(job.id + '：没写账本路径'); continue; }
    const briefFile = resolve(job.brief);
    const ledgerFile = resolve(job.ledger);
    if (briefSeen.has(briefFile)) problems.push(job.id + '：派活单与另一路是同一个文件');
    briefSeen.add(briefFile);
    if (ledgerSeen.has(ledgerFile)) problems.push(job.id + '：账本与另一路是同一个文件');
    ledgerSeen.add(ledgerFile);

    if (!fs.existsSync(briefFile)) { problems.push(job.id + '：派活单不在盘上（' + job.brief + '）'); continue; }
    if (!/^[0-9a-f]{64}$/.test(job.sha)) { problems.push(job.id + '：sha256 不是 64 位十六进制'); continue; }
    const actual = sha256File(briefFile);
    if (actual !== job.sha) problems.push(job.id + '：派活单在发出之后被改过（清单写 ' + job.sha.slice(0, 12) + '，盘上 ' + actual.slice(0, 12) + '）');
  }

  for (const item of items) {
    const job = jobs.find((j) => j.id === item.id);
    if (!job) continue;
    if (!STATES.includes(item.state)) {
      problems.push(item.id + '：状态是「' + item.state + '」，只认 ' + STATES.join(' 或 '));
      continue;
    }
    if (item.ledger && resolve(item.ledger) !== resolve(job.ledger)) {
      problems.push(item.id + '：转交单写的账本与派活清单不是同一份（' + item.ledger + ' / ' + job.ledger + '）');
    }
    if (item.state === '已交回' && !fs.existsSync(resolve(job.ledger))) {
      problems.push(item.id + '：标了已交回，账本不在盘上（' + job.ledger + '）');
    }
  }

  checkNoContent(transferText, problems);

  const done = items.filter((i) => i.state === '已交回').length;
  const pending = items.filter((i) => i.state === '未交回').length;
  notes.push('派活 ' + jobs.length + ' 路，已交回 ' + done + '，未交回 ' + pending);
  return { ok: problems.length === 0, problems, notes, jobs: jobs.length, done, pending };
}

const USAGE = [
  '用法：node scripts/router-check.mjs <派活清单.md> <转交单.md>',
  '',
  '派活清单表头：id | 派活单 | sha256 | 账本',
  '转交单表头：  id | 账本 | 状态',
  '',
  '查：id 集合相等且各一次；派活单哈希没变；标了已交回的账本在盘上；',
  '状态只有 已交回/未交回；转交单里没有表格之外的文字、反引号、',
  '文件:行号或超长单元格。相对路径按派活清单所在目录解析。',
].join('\n');

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h') || argv.length < 2) {
    console.log(USAGE);
    process.exit(argv.length < 2 && !argv.includes('--help') && !argv.includes('-h') ? 2 : 0);
  }
  const [manifestPath, transferPath] = argv;
  let result;
  try {
    result = checkRouter(manifestPath, transferPath);
  } catch (e) {
    console.error('router-check: 读不了输入：' + e.message);
    process.exit(2);
  }
  for (const note of result.notes) console.log('router-check: ' + note);
  for (const problem of result.problems) console.log('FAIL ' + problem);
  if (result.ok) {
    console.log('router-check: 通过（' + result.jobs + ' 路，0 失败）');
    process.exit(0);
  }
  console.log('router-check: ' + result.problems.length + ' 项失败');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  installRunLog('router-check.mjs');
  main(process.argv.slice(2));
}
