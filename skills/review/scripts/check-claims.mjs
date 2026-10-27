#!/usr/bin/env node
/**
 * 自由形态的语义检查：不认段名、不认表、不认块序。
 *
 * 只核四件事——交付物里凡是能核的：
 *   1. 有没有没填的槽位（〈…〉）；
 *   2. 有没有审批词与完整性命题（「能合」「没有遗漏」这类）；
 *   3. 「依据」后面是不是四个词之一；
 *   4. 标了「严重」的地方，同行或前后两行有没有硬依据（跑了命令／引了原文／两处代码路径对照）。
 *
 * 用法：node check-claims.mjs <文件.md> [<文件.md> ...]
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EVIDENCE = ['跑了命令', '引了原文', '读源码', '推断'];
const HARD = ['跑了命令', '引了原文', '两处代码路径对照'];
const SLOT = /〈[^〉\n]{1,40}〉/;
const ICON = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
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
    if (ICON.test(raw)) problems.push(at('出现了图标或 emoji'));
    if (APPROVAL.test(line)) problems.push(at('出现了审批词——直接说事，不说"能合／放行"'));
    if (COMPLETE.test(line)) problems.push(at('出现了完整性命题——只能说"在覆盖表内未发现"'));

    const ev = line.match(/(?:^|[|｜;；,，。、\s])依据[：:]\s*([^\s，。；、|]?)/);
    if (ev !== null && ev[1] !== '' && !EVIDENCE.some((w) => line.includes(w))) {
      problems.push(at(`「依据：」后面不是 ${EVIDENCE.join('／')} 之一——拼写要一致，校验靠它`));
    }

    if (line.includes('严重')) {
      const near = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
      if (!HARD.some((w) => near.includes(w))) {
        problems.push(at('标了「严重」，前后两行里没有硬依据（跑了命令／引了原文／两处代码路径对照）——降级或补依据'));
      }
    }
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
    else { bad += problems.length; console.log(`FAIL ${f}`); for (const p of problems) console.log(`  - ${p}`); }
  }
  process.exitCode = bad > 0 ? 1 : 0;
}
