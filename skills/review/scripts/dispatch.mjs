#!/usr/bin/env node
// 发路：把派活清单变成一串固定动作，路由没有需要判断的地方。
//
// 用法：
//   node scripts/dispatch.mjs <派活清单.md>                             打印这一轮的发送单
//   node scripts/dispatch.mjs <派活清单.md> --init-transfer <转交单.md>  写一张全是「未交回」的转交单
//   node scripts/dispatch.mjs <派活清单.md> --reconcile <转交单.md>      按账本在不在盘上填状态，再跑 router-check
//
// 它只做三件事：核清单本身（表头、id 唯一、派活单还是发出去时那一份）、打印按行执行的
// 发送单、按账本存在性填转交单。不判断任何一条发现，不读被审对象，也不读派活单的内容
// ——发送时交出去的是路径，由子代理自己打开。
//
// 退出码：0 通过 / 1 有问题 / 2 用法或读取失败。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRouter, MANIFEST_COLUMNS, parseTable, cellOf, sha256File } from './router-check.mjs';

const SHA = /^[0-9a-f]{64}$/;

function loadManifest(manifestPath) {
  const problems = [];
  const dir = path.dirname(path.resolve(manifestPath));
  const text = fs.readFileSync(manifestPath, 'utf8');
  const table = parseTable(text);
  if (!table) return { jobs: [], problems: ['派活清单：找不到表格'], dir };
  const missing = MANIFEST_COLUMNS.filter((c) => !table.header.includes(c));
  if (missing.length) problems.push('派活清单：表头缺列 ' + missing.join('、'));
  const jobs = table.rows.map((row) => ({
    id: cellOf(row, table.header, 'id'),
    brief: cellOf(row, table.header, '派活单'),
    sha: cellOf(row, table.header, 'sha256').toLowerCase(),
    ledger: cellOf(row, table.header, '账本'),
  }));
  const seen = new Set();
  for (const job of jobs) {
    if (!job.id) { problems.push('派活清单有空 id 的行'); continue; }
    if (seen.has(job.id)) problems.push(job.id + ' 出现了不止一次');
    seen.add(job.id);
    if (!job.brief || !fs.existsSync(path.resolve(dir, job.brief))) {
      problems.push(job.id + '：派活单不在盘上');
      continue;
    }
    if (!SHA.test(job.sha)) { problems.push(job.id + '：sha256 不是 64 位十六进制'); continue; }
    if (sha256File(path.resolve(dir, job.brief)) !== job.sha) {
      problems.push(job.id + '：派活单在清单写定之后被改过');
    }
  }
  return { jobs, problems, dir };
}

function transferText(jobs, isDone) {
  const lines = ['| id | 账本 | 状态 |', '| --- | --- | --- |'];
  for (const j of jobs) lines.push('| ' + j.id + ' | ' + j.ledger + ' | ' + (isDone(j) ? '已交回' : '未交回') + ' |');
  return lines.join('\n') + '\n';
}

function emit(jobs, manifestPath) {
  console.log('# 发送单（按顺序，一行一次；发完就结束这一轮）');
  console.log('');
  console.log('每一行只做一个动作：把这个路径交给子代理，让它打开并执行；不要改写、不要摘要、不要补充要求。');
  console.log('');
  jobs.forEach((j, i) => console.log((i + 1) + '. ' + j.id + '  →  ' + j.brief));
  console.log('');
  console.log('发完不检查、不汇总、不复述——回收是下一轮的事：');
  console.log('  node scripts/dispatch.mjs ' + manifestPath + ' --reconcile <转交单>');
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h') || argv.length < 1) {
    console.log('用法：node scripts/dispatch.mjs <派活清单.md> [--init-transfer|--reconcile <转交单.md>]');
    process.exit(argv.length < 1 ? 2 : 0);
  }
  const manifestPath = argv[0];
  const flag = argv[1] || '';
  const transferPath = argv[2] || '';
  let loaded;
  try {
    loaded = loadManifest(manifestPath);
  } catch (e) {
    console.error('dispatch: 读不了派活清单：' + e.message);
    process.exit(2);
  }
  if (loaded.problems.length) {
    for (const p of loaded.problems) console.log('FAIL ' + p);
    console.log('dispatch: ' + loaded.problems.length + ' 项失败，先修清单再发路');
    process.exit(1);
  }
  if (flag === '--init-transfer' || flag === '--reconcile') {
    if (!transferPath) { console.error('dispatch: 这个开关要跟一个转交单路径'); process.exit(2); }
    const done = flag === '--reconcile';
    const text = transferText(loaded.jobs, (j) => done && fs.existsSync(path.resolve(loaded.dir, j.ledger)));
    fs.writeFileSync(transferPath, text);
    const result = checkRouter(manifestPath, transferPath);
    for (const note of result.notes) console.log('dispatch: ' + note);
    for (const problem of result.problems) console.log('FAIL ' + problem);
    if (!result.ok) process.exit(1);
    console.log('dispatch: 转交单已写入 ' + transferPath + (done ? '（按账本存在性重填）' : '（全部未交回）'));
    process.exit(0);
  }
  emit(loaded.jobs, manifestPath);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
