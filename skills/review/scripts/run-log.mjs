#!/usr/bin/env node
// 仪器调用日志：脚本被真的调起时留一行，行与行用哈希串起来。
// 它证明的是「这一次调用发生过」，证明不了「模型读过什么」，也证明不了
// 「日志不是事后整体伪造的」——后者只有宿主能管（见 .debug-session/LIMITS.md 的 L3）。
//
// 路径：$REVIEW_RUN_LOG，否则 <cwd>/.review-run-log.jsonl。写不进去时只报一行，
// 不改退出码——记录失败不该让评审本身失败。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function logPath() {
  return process.env.REVIEW_RUN_LOG || path.join(process.cwd(), '.review-run-log.jsonl');
}

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// 存在就返回原始行数组，不存在返回 null——「没有这个文件」和「文件是空的」是两件事。
export function readRunLog(p = logPath()) {
  if (!p || !fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').split('\n').filter((s) => s.length > 0);
}

// 断链检查：每一行的 prev 要等于上一原始行的哈希（第一行等于 'genesis'），
// 且 self 要等于本行去掉 self 之后的哈希。返回空数组＝链是完整的。
export function verifyChain(lines) {
  const bad = [];
  let prev = 'genesis';
  (lines || []).forEach((raw, i) => {
    const at = i + 1;
    let o;
    try { o = JSON.parse(raw); } catch { bad.push({ at, why: '这一行不是 JSON' }); prev = sha(raw); return; }
    if (o.prev !== prev) bad.push({ at, why: 'prev 对不上上一行：中间有行被插入或被删' });
    const { self, ...rest } = o;
    if (self !== sha(JSON.stringify(rest))) bad.push({ at, why: 'self 与内容对不上：这一行被改过' });
    prev = sha(raw);
  });
  return bad;
}

// 在 CLI 入口块里调用一次即可：任何结束路径（process.exit／exitCode／抛异常）都会收尾。
export function installRunLog(script, argv = process.argv.slice(2)) {
  const started = Date.now();
  const finish = (code) => {
    try {
      appendRunLog({
        script,
        argv,
        exit: typeof code === 'number' ? code : (typeof process.exitCode === 'number' ? process.exitCode : 0),
        ms: Date.now() - started,
      });
    } catch (e) {
      try { console.error('run-log: 这一行没写进去（' + (e.code || e.message) + '）；结论不变，日志少一行'); } catch {}
    }
  };
  process.once('exit', finish);
  return { finish };
}

// 追加一行并接上链。调用处要自己保证不抛到外面（记录失败不该让评审失败）。
export function appendRunLog({ script, argv = [], exit = 0, ms = 0, cwd = process.cwd(), file = logPath() }) {
  const lines = readRunLog(file) || [];
  const prev = lines.length ? sha(lines[lines.length - 1]) : 'genesis';
  const rec = { t: new Date().toISOString(), ms, script, argv, cwd, exit, prev };
  fs.appendFileSync(file, JSON.stringify({ ...rec, self: sha(JSON.stringify(rec)) }) + '\n');
  return rec;
}
