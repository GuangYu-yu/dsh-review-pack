#!/usr/bin/env node
/**
 * 自由形态的语义检查：不认段名、不认表、不认块序、不认词表。
 *
 * 只核两件能判真假的事：
 *   1. 有没有没填的槽位（〈…〉）——模板不是交付物；
 *   2. 有没有替读者宣布通过、或声称"没有遗漏"这类完整性命题。
 *
 * 用法：node check-claims.mjs <文件.md> [<文件.md> ...]
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SLOT = /〈[^〉\n]{1,40}〉/;
const APPROVAL = /能合|不能合|可以放行|建议合并|准予|批准/;
const COMPLETE = /没有遗漏|都查过了|全面覆盖|万无一失/;

function mask(text) {
  const lines = text.split('\n');
  let fence = false;
  return lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return ''; }
    return fence ? '' : l;
  });
}

export function scan(text) {
  const problems = [];
  const lines = mask(text);
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/`[^`]*`/g, '');
    const at = (msg) => `第 ${n} 行 ${msg}`;

    const slot = line.match(SLOT);
    if (slot !== null) problems.push(at(`还有没填的槽位 ${slot[0]}——交付前换成实际值`));
    if (APPROVAL.test(line)) problems.push(at('出现了审批词——直接说事，不说"能合／放行"'));
    if (COMPLETE.test(line)) problems.push(at('出现了完整性命题——只能说"在覆盖表内未发现"'));
  });
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (files.length === 0) { console.error('用法：node check-claims.mjs <文件.md> [...]'); process.exit(2); }
  let bad = 0;
  for (const f of files) {
    if (!existsSync(f)) { console.error(`找不到：${f}`); process.exitCode = 2; continue; }
    const problems = scan(readFileSync(f, 'utf8'));
    if (problems.length === 0) console.log(`OK   ${f}`);
    else { bad += 1; console.log(`FAIL ${f}`); for (const p of problems) console.log(`  ${p}`); }
  }
  if (bad > 0) process.exitCode = 1;
}
