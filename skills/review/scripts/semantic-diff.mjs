#!/usr/bin/env node
// 句级差分：比词更接近「意思有没有被改没」。它仍然不是语义检查——
// 它只回答「哪几句没了、哪几句新增、哪几句被改了」，判断要人做。
import fs from 'node:fs';
import path from 'node:path';

const norm = (s) => s.replace(/[\s*_·>|]/g, '').trim();
const split = (t) => t.split(/\n/).flatMap((line) =>
  line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').split(/(?<=[。；！？])/))
  .map((s) => s.trim()).filter((s) => norm(s).length >= 8);

const bigrams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
const sim = (a, b) => {
  a = norm(a); b = norm(b);
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const x of A) if (B.has(x)) hit++;
  return (2 * hit) / (A.size + B.size);
};

function walk(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.name.endsWith('.md')) out[path.relative(base, p).replace(/\\/g, '/')] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

export function diffTrees(oldDir, newDir, threshold = 0.55) {
  const A = walk(oldDir), B = walk(newDir);
  const files = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
  const report = [];
  for (const f of files) {
    if (!(f in B)) { report.push({ file: f, removed: split(A[f] || ''), added: [], rewritten: [], gone: true }); continue; }
    if (!(f in A)) { report.push({ file: f, removed: [], added: split(B[f]), rewritten: [], fresh: true }); continue; }
    const oldS = split(A[f]), newS = split(B[f]);
    const used = new Set();
    const removed = [], rewritten = [];
    for (const s of oldS) {
      let best = 0, bi = -1;
      newS.forEach((t, i) => { if (used.has(i)) return; const v = sim(s, t); if (v > best) { best = v; bi = i; } });
      if (best >= 0.999) { used.add(bi); continue; }
      if (best >= threshold) { used.add(bi); rewritten.push({ from: s, to: newS[bi] }); continue; }
      removed.push(s);
    }
    const added = newS.filter((_, i) => !used.has(i));
    if (removed.length || added.length || rewritten.length) report.push({ file: f, removed, added, rewritten });
  }
  return report;
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/')).href) {
  const [oldDir, newDir] = process.argv.slice(2);
  if (!oldDir || !newDir) { console.log('用法：node scripts/semantic-diff.mjs <旧目录> <新目录> [--full]'); process.exit(2); }
  const full = process.argv.includes('--full');
  const r = diffTrees(oldDir, newDir);
  let rm = 0, ad = 0, rw = 0;
  for (const f of r) {
    rm += f.removed.length; ad += f.added.length; rw += f.rewritten.length;
    console.log('\n## ' + f.file + (f.gone ? '（整份没了）' : '') + '  -' + f.removed.length + ' +' + f.added.length + ' ~' + f.rewritten.length);
    if (full) {
      for (const s of f.removed) console.log('  - ' + s);
      for (const x of f.rewritten) console.log('  ~ ' + x.from + '\n    → ' + x.to);
      for (const s of f.added) console.log('  + ' + s);
    }
  }
  console.log('\n合计：消失 ' + rm + ' 句，改写 ' + rw + ' 句，新增 ' + ad + ' 句（判读要人做，脚本只负责摆出来）');
}