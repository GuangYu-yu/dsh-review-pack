#!/usr/bin/env node
// 一次跑完全部机械检查：交付物的内容、账本、锚点、目录残留、分路覆盖。
// 用法：
//   node review-check.mjs <产出目录> [--root <对象根>] [--lanes <lanes.json>] [--scope <范围清单>] [--json]
// 退出码：0 全部通过；1 有不通过项；2 用法或环境错误。
//
// 它不认报告的形状：没有段名、没有表也能过。内容项由 check-claims.mjs 判
// （未填槽位、替读者宣布通过、完整性命题三类），这里只管"该不该出现在这个目录里"
// 和"能不能对上源"。账本的形状也由主审定：只要有一张表、表头里有「位置」列。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scan as scanClaims } from './check-claims.mjs';
import { validateFile, parseLedger } from './ledger.mjs';
import { verify } from './verify-quotes.mjs';

const USAGE = `用法：node review-check.mjs <产出目录> [--root <对象根>] [--lanes <lanes.json>] [--scope <范围清单>] [--json]

产出目录里应当有一份交付物（报告或一段结论）；分过路或分过轮的评审，旁边还应当有一本合并后的账本，其余工作文件放在被审对象之外。
--root 给了就同时核每条「文件:行号」锚点（文件在不在、行号越没越界）。
--lanes 给了就核分路覆盖：对象根下每个匹配扩展名的文件，至少被一路点名；同时要求交付目录里有账本。
--lanes 还核「位置从哪来」：报告里的每个位置，要么出现在某一路交回的账本里，要么报告里写出「主审回源 N 处」、N 等于实际对不上的数目。全部来自分路账本时这一行可以没有。
--lanes 核派活范围：分路清单里派出去的文件必须在范围清单内——清单先写、派活只派清单内的。
--scope 给了就核越界：报告与账本里（含分路账本）的每个位置，要么在范围清单里，要么那一条自己标了「清单外」。它核的是标没标，核不了读了多少。分过路（--lanes）时必须给。
--scope 还核覆盖：清单里标了未读／跳过的文件，报告里要么逐个点名，要么写出一个与实际相等的数。

账本「根」那一节每一行都要挂得上：要么写出它管着哪几条（编号），要么位置落在某一条发现上。报告里写了「其余 N 条」时，N 要和账本里没进报告的那些条数相等。`;

// 账本：表头里有一列叫「位置」，正文基本就是这张表。不认列名、不认列数、不认顺序——
// 曾经用一张固定列名的正则认账本，结果自由表头的账本被当成了第二份交付物。
const LEDGER_COLUMN = /\|\s*位置\s*\|/;
function looksLikeLedger(name, text) {
  if (!LEDGER_COLUMN.test(text)) return false;
  if (/ledger|账本/i.test(name)) return true;
  let table = 0;
  let prose = 0;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith('>')) continue;
    if (t.startsWith('|')) table += 1;
    else prose += 1;
  }
  // 账本整篇就是表（加表头与注解）；报告总有几行成文的句子。一条正文都没有才算账本——
  // 放宽到"几行以内"时，一张只有表格的报告会被判成账本，于是"两份账本、没有交付物"。
  return table >= 2 && prose === 0;
}
const SKIP_DIRS = ['.git', 'node_modules', 'target', 'dist', '.release', 'vendor', '.next'];

// 范围清单：对象根下该看的文件一行一个，后面写"读了／未读／跳过（理由）"。
// 只认每行第一个像路径的词，其余一律不管——它是工作文件，形状不该被脚本规定。
// 这一节核的是"标没标"，不是"读了多少"：后者机械判不了，别在这里假装。
const SCOPE_LABEL = /清单外|范围外|越界|未列入|不在清单/;
const POS_RE = /[A-Za-z0-9_./\\:-]*\.[A-Za-z0-9]+:\d+/g;
// 清单的一行除了路径，还可以写读到什么程度。看起来在说"没读"的那些要留出来：
// 清单说了没读、报告却从不提，读者就会以为那一块读过。
const SKIP_MARK = /未读|没读|未看|跳过|不看|没展开/;
function parseScopeDetailed(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    let t = raw.trim();
    if (!t || /^[#>|]/.test(t)) continue;
    const skipped = SKIP_MARK.test(t);
    t = t.replace(/^[-*+]\s+/, '').replace(/`/g, '');
    const m = t.match(/^([^\s（(),]+)/);
    if (!m) continue;
    const p = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
    if (!/\//.test(p) && !/\.[A-Za-z0-9]+$/.test(p)) continue;
    if (/^\d+\.\d+/.test(p)) continue;
    out.push({ path: p, skipped });
  }
  return out;
}
function parseScope(text) {
  return parseScopeDetailed(text).map((e) => e.path);
}
const hasPos = (s) => s.match(POS_RE) !== null;
// 「根」这类节写的是改哪一处、管着哪几条，不是发现本身；算账本规模时要把它和发现分开。
const ROOT_TITLE = /根|合并|独立/;
function scopeMatch(pos, entries) {
  const p = pos.replace(/\\/g, '/').replace(/^\.\//, '');
  let best = null;
  for (const e of entries) {
    if (p === e || p.endsWith('/' + e) || e.endsWith('/' + p)) {
      if (!best || e.length > best.length) best = e;
    }
  }
  // 不按文件名兜底：两份同名文件（src/cmd/plan.rs 与 src/movepart/plan.rs）会被认成同一份，
  // 于是越界的条目看着像在清单里。认不出就当清单外——宁可让作者把路径写全。
  return best ? { how: 'path', entry: best } : null;
}
// 一个位置算不算"标了"，按它所在的那一块看：一段（空行隔开）、一个标题下、或表的一行。
// 表不能整张算一块，否则表里任意一处写了"清单外"，全表都被兜住。
function positionsWithBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blockOf = (i) => {
    if (lines[i].trim().startsWith('|')) return lines[i];
    let a = i;
    let b = i;
    while (a > 0 && lines[a - 1].trim() !== '' && !lines[a - 1].trim().startsWith('#')) a--;
    while (b + 1 < lines.length && lines[b + 1].trim() !== '' && !lines[b + 1].trim().startsWith('#')) b++;
    return lines.slice(a, b + 1).join('\n');
  };
  const found = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(POS_RE)) {
      if (m[0].includes('://')) continue;
      found.push({ pos: m[0], block: blockOf(i), line: i + 1 });
    }
  });
  return found;
}

// 位置的归一化：写法不同、指的还是同一处。只做能判死的两件事，不做路径推断。
function normPos(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
function collectPos(text) {
  const set = new Set();
  for (const line of text.split(/\r?\n/)) {
    for (const m of line.matchAll(POS_RE)) {
      if (m[0].includes('://')) continue;
      set.add(normPos(m[0]));
    }
  }
  return set;
}
// 分路账本写的是对象根起的路径，报告里可能多一层目录或少一层。带行号一起比，
// 后缀相同就算同一处——比只比文件名严（两份同名文件的行号不会碰巧一致）。
function inPosSet(pos, set) {
  if (set.has(pos)) return true;
  for (const q of set) {
    if (pos.endsWith('/' + q) || q.endsWith('/' + pos)) return true;
  }
  return false;
}
// 分路清单里每一路的账本落在哪。路径按分路清单所在目录解析，读不到也返回（调用方决定怎么报）。
function laneLedgers(lanesFile) {
  const out = [];
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(lanesFile, 'utf8'));
  } catch {
    return out;
  }
  const base = path.dirname(path.resolve(lanesFile));
  for (const lane of manifest.lanes || []) {
    if (!lane.ledger) continue;
    const p = path.isAbsolute(lane.ledger)
      ? lane.ledger
      : fs.existsSync(path.resolve(base, lane.ledger))
        ? path.resolve(base, lane.ledger)
        : path.resolve(lane.ledger);
    out.push({ name: lane.name || '?', path: p, exists: fs.existsSync(p) });
  }
  return out;
}
function walkFiles(root, exts = null) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.includes(e.name)) continue;
        walk(p);
      } else if (!exts || exts.includes(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

export function runCheck({ dir, root = null, lanesFile = null, scopeFile = null }) {
  const problems = [];
  const notes = [];
  const fail = (msg) => problems.push(msg);

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ok: false, problems: [`产出目录不存在：${dir}`], notes };
  }

  // 1. 目录里有什么：账本另算，其余 .md 都是候选交付物
  const md = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort();
  const deliverables = [];
  let ledgerFile = null;
  for (const name of md) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const isLedger = looksLikeLedger(name, text);
    if (isLedger) {
      if (/ledger-L\d+/i.test(name)) fail(`${name}：这是分路账本，回收时应当已经合并并删掉`);
      else if (ledgerFile) fail(`有两份账本：${ledgerFile}、${name}——合并后只留一份`);
      else ledgerFile = name;
    } else {
      deliverables.push(name);
    }
  }
  const reportFile = deliverables[0] || null;
  if (deliverables.length === 0) fail('目录里没有交付物——报告、一段结论、一张清单都算，工作文件不算');
  else if (deliverables.length > 1) fail(`有两份交付物：${deliverables.join('、')}——对外只交一份，其余放被审对象之外`);
  if (!ledgerFile) {
    if (lanesFile) fail('分过路却没有账本：交付目录里应当是报告 + 一本合并后的账本');
    else notes.push('目录里没有账本——只有没分过路的轻量评审可以这样');
  }

  // 2. 交付物的内容（不认形状）
  if (reportFile) {
    const p = path.join(dir, reportFile);
    for (const item of scanClaims(fs.readFileSync(p, 'utf8'))) fail(`交付物 ${reportFile} ${item}`);
  }

  // 3. 账本
  if (ledgerFile) {
    const p = path.join(dir, ledgerFile);
    const text = fs.readFileSync(p, 'utf8');
    const v = validateFile(text, ledgerFile);
    const list = v.problems || (Array.isArray(v) ? v : []);
    for (const item of list) fail(`账本 ${typeof item === 'string' ? item : item.msg || JSON.stringify(item)}`);
    notes.push(`账本 ${ledgerFile}：${(v.rows || []).length} 条`);

    // 根节：报告第 2 项的唯一来源。条目够多却一条根都不写，说明分组那一环没做。
    if ((v.rows || []).length >= 5) {
      const { sections } = parseLedger(text, ledgerFile);
      // 一条都并不起来时，结论写在节标题上（`# 根：无可合并，N 条独立`）——账本的每一行都必须带「文件:行号」，
      // 所以"没有根"这件事没有行可以承载，只能落在标题里。
      const roots = (sections || []).filter(
        (s) => /根|合并|独立/.test(s.title || '') && (s.rows.length > 0 || /可合并|独立/.test(s.title || '')),
      );
      if (roots.length === 0) {
        fail(`账本 ${ledgerFile} 没有「根」这一节（${v.rows.length} 条发现）：报告第 2 项会没有来源——一行一个根，写改哪一处、挂着哪几条、什么会推翻它；一条都并不起来就把结论写在节标题上（「# 根：无可合并，N 条独立」）`);
      } else {
        const total = roots.reduce((n, s) => n + s.rows.length, 0);
        // 根要挂得上：一行说"改哪一处"，就要说得出它管着账本上的哪几条。判得了的只有两件——
        // 位置与某一行账本相同，或写出 1..N 的编号；"这是不是真根"仍只能读。
        // 只拿「发现」那些节的位置：根这一节自己的行也在 v.rows 里，
        // 用它比等于自己跟自己比，任何一行都能挂上。
        const ledgerPos = new Set();
        for (const sec of sections || []) {
          if (ROOT_TITLE.test(sec.title || '')) continue;
          const idx = (sec.columns || []).indexOf('位置');
          if (idx < 0) continue;
          for (const row of sec.rows) {
            for (const m of (row.cells[idx] || '').matchAll(POS_RE)) ledgerPos.add(normPos(m[0]));
          }
        }
        const unmounted = [];
        for (const s of roots) {
          for (const row of s.rows) {
            const cells = row.cells || [];
            const posHit = cells.some((c) => [...collectPos(c)].some((p) => inPosSet(p, ledgerPos)));
            let numHit = false;
            for (const cell of cells) {
              if (hasPos(cell)) continue;
              // 纯数字的格子是编号列，不是"管着哪几条"
              if (/^\s*#?\d+\s*$/.test(cell)) continue;
              for (const m of cell.matchAll(/#?(\d+)/g)) {
                const n = Number(m[1]);
                if (n >= 1 && n <= (v.rows || []).length) numHit = true;
              }
            }
            if (!posHit && !numHit) unmounted.push(cells.join(' | ').slice(0, 70));
          }
        }
        if (unmounted.length) {
          const shown = unmounted.slice(0, 2).join(' / ');
          fail(`账本 ${ledgerFile} 的「根」有 ${unmounted.length} 行挂不上：既没写它管着哪几条（编号），位置也不在任何一行账本里——${shown}${unmounted.length > 2 ? ' 等' : ''}。根要能追回它管的行，否则报告第 2 项就是一句没法核的话`);
        }
        notes.push(total === 0 ? `根：无可合并（${roots.map((s) => s.title).join('、')}）` : `根 ${total} 条（${roots.map((s) => s.title).join('、')}）`);
      }
    }
  }

  // 4. 锚点
  if (reportFile && root) {
    const p = path.join(dir, reportFile);
    const q = verify(fs.readFileSync(p, 'utf8'), { file: reportFile, root: path.resolve(root) });
    if (q.anchorsChecked === 0) notes.push('锚点 0 处：交付物里没有任何 `文件:行号`，这一项没有可核的');
    for (const item of q.problems) fail(`锚点 ${item.msg || item.code}`);
    notes.push(`锚点 ${q.anchorsChecked} 处 · 引文 ${q.quotesChecked} 条 · 提示 ${q.advisories.length} 项`);
  }

  // 4b. 第 2 项：发现了若干条，却没写"哪些条共用一个改动"（或没写它们互相独立）
  if (reportFile) {
    const text = fs.readFileSync(path.join(dir, reportFile), 'utf8');
    const anchors = (text.match(/[A-Za-z0-9_./\\:-]*\.[A-Za-z0-9]+:\d+/g) || []).length;
    const declared = /根因|共同根|可合并|互相独立|各自独立|彼此独立|只有散条|综合没做/.test(text);
    if (anchors >= 4 && !declared) {
      fail(`交付物 ${reportFile} 有 ${anchors} 处位置，却没有"哪些条会被同一个改动一起消掉"的结论，也没写"互相独立"——第 2 项空着要写成结论，沉默读者分不清是判过还是没走到`);
    }
  }

  // 4c. 越界：位置要么在范围清单里，要么那一条自己标了清单外
  // 清单只读一次：越界、分路派活、覆盖表三处都要用同一份。
  let scopeDetail = null;
  let scopeEntries = null;
  if (scopeFile) {
    try {
      scopeDetail = parseScopeDetailed(fs.readFileSync(scopeFile, 'utf8'));
    } catch (e) {
      return { ok: false, problems: [`读不了范围清单 ${scopeFile}：${e.message}`], notes };
    }
    scopeEntries = scopeDetail.map((e) => e.path);
    if (scopeEntries.length === 0) {
      fail(`范围清单 ${scopeFile} 里一个路径都没认出来——一行一个文件路径，后面写"读了／未读／跳过（理由）"`);
    }
  }
  if (scopeEntries && scopeEntries.length > 0) {
    const entries = scopeEntries;
    {
      const targets = [];
      if (reportFile) targets.push([reportFile, fs.readFileSync(path.join(dir, reportFile), 'utf8')]);
      if (ledgerFile) targets.push([ledgerFile, fs.readFileSync(path.join(dir, ledgerFile), 'utf8')]);
      // 分路账本也核：只核合并后的账本，越界行在合并时被删掉就查不出来。
      for (const l of lanesFile ? laneLedgers(lanesFile) : []) {
        if (l.exists) targets.push([`分路账本 ${l.name}`, fs.readFileSync(l.path, 'utf8')]);
      }
      const seen = new Set();
      const unlabeled = [];
      let inside = 0;
      let labeled = 0;
      for (const [, text] of targets) {
        for (const { pos, block } of positionsWithBlocks(text)) {
          if (seen.has(pos)) continue;
          seen.add(pos);
          const hit = scopeMatch(pos.replace(/:\d+$/, ''), entries);
          if (hit) {
            inside += 1;
            continue;
          }
          if (SCOPE_LABEL.test(block)) labeled += 1;
          else unlabeled.push(pos);
        }
      }
      if (unlabeled.length) {
        const shown = unlabeled.slice(0, 5).join('、');
        fail(`${unlabeled.length} 处位置不在范围清单里，那一条也没标"清单外"：${shown}${unlabeled.length > 5 ? ' 等' : ''}——要么把它加进清单并说明原计划为什么没含它，要么在那一块里写明读到了什么程度、纳入范围与否交给读者定`);
      }
      notes.push(`范围清单 ${entries.length} 个文件 · 位置在清单内 ${inside} 处 · 清单外且已标 ${labeled} 处`);
    }
  } else if (lanesFile) {
    fail('分过路却没给 --scope <范围清单>：越界这一项没法事后补——过程里要有一份"对象根下该看的文件一行一个"，报告与账本里的位置都按它核');
  }

  // 4d. 位置从哪来：分路账本里有、还是只在报告里出现。
  // 机械判得了的只有这一件：报告里的位置在不在某一路交回的账本里。它核不出那一路
  // 是不是真读了自己那份（账本是那一路自己写的），但"窗口自己读、自己写报告"会在
  // 这里留下一串没有来源的位置——这是路由在产物上唯一的痕迹。
  if (lanesFile && reportFile) {
    let laneManifest = null;
    try {
      laneManifest = JSON.parse(fs.readFileSync(lanesFile, 'utf8'));
    } catch (e) {
      fail(`读不了分路清单 ${lanesFile}：${e.message}`);
    }
    if (laneManifest) {
      const lanePos = new Set();
      const unreadable = [];
      for (const lane of laneLedgers(lanesFile)) {
        if (!lane.exists) {
          unreadable.push(lane.name);
          continue;
        }
        for (const pos of collectPos(fs.readFileSync(lane.path, 'utf8'))) lanePos.add(pos);
      }
      if (unreadable.length) {
        fail(`分路账本读不到：${unreadable.join('、')}——回收时账本要留到交付目录旁边，它是"这条发现谁核的"唯一的凭据`);
      }
      const reportText = fs.readFileSync(path.join(dir, reportFile), 'utf8');
      const reportPos = collectPos(reportText);
      const orphans = [...reportPos].filter((p) => !inPosSet(p, lanePos));
      if (orphans.length === 0) {
        notes.push(`位置来源：报告 ${reportPos.size} 处，全部出现在分路账本里`);
      } else {
        const shown = orphans.slice(0, 5).join('、');
        const DECL = /(?:回源|一手核|亲自核)[^\d\n]{0,15}(\d+)\s*处|只在报告里[^\d\n]{0,15}(\d+)\s*处/g;
        const declared = [...reportText.matchAll(DECL)].map((m) => Number(m[1] ?? m[2]));
        if (declared.length === 0) {
          fail(`${orphans.length} 处位置不在任何一路的账本里：${shown}${orphans.length > 5 ? ' 等' : ''}——报告里要有一行「主审回源 N 处」，N 等于实际数；要么把它们补进某一路的账本。这一行的数一变大，就说明窗口在自己读，路由编制没成立`);
        } else if (!declared.includes(orphans.length)) {
          fail(`报告写的是回源 ${declared.join('、')} 处，实际对不上的是 ${orphans.length} 处（${shown}${orphans.length > 5 ? ' 等' : ''}）——数对不上，等于没有交代`);
        } else {
          notes.push(`位置来源：分路账本 ${lanePos.size} 处 · 报告 ${reportPos.size} 处 · 主审自核 ${orphans.length} 处（已声明）`);
        }
      }
    }
  }

  // 4e. 报告说「其余 N 条」时，N 要和账本对得上（format.md 第五节那一条）。
  // 只核报告自己声明过的数：正文只放会改变读者动作的，账本里留几条是合法写法，
  // 没有哪条要求把"没进正文的条数"写成必填项——但写了，就得是真数。
  // 没写时给一行说明，让"报告没提账本里这几条"这件事至少不是隐形的。
  if (ledgerFile && reportFile) {
    const text = fs.readFileSync(path.join(dir, reportFile), 'utf8');
    const reportPos = collectPos(text);
    const ledgerText = fs.readFileSync(path.join(dir, ledgerFile), 'utf8');
    const { sections } = parseLedger(ledgerText, ledgerFile);
    const findingPos = new Set();
    for (const s of sections || []) {
      if (ROOT_TITLE.test(s.title || '')) continue;
      const idx = (s.columns || []).indexOf('位置');
      if (idx < 0) continue;
      for (const row of s.rows) {
        for (const m of (row.cells[idx] || '').matchAll(POS_RE)) findingPos.add(normPos(m[0]));
      }
    }
    const miss = [...findingPos].filter((p) => !inPosSet(p, reportPos));
    if (miss.length === 0) {
      notes.push('账本每一条都在报告里出现过');
    } else {
      const D = /(?:其余|另|另有|还有)[^\d\n]{0,12}(\d+)\s*(?:条|处)/g;
      const nums = [...text.matchAll(D)].map((m) => Number(m[1]));
      const shown = miss.slice(0, 4).join('、');
      if (nums.length === 0) {
        notes.push(`账本有 ${miss.length} 条没在报告里出现（${shown}${miss.length > 4 ? ' 等' : ''}）——报告没写这个数，读的人不会知道有这几条`);
      } else if (!nums.includes(miss.length)) {
        fail(`报告写「其余 ${nums.join('、')} 条」，可账本里没在报告里出现的是 ${miss.length} 条（${shown}${miss.length > 4 ? ' 等' : ''}）——数对不上，读者会按你写的那个数去账本里找`);
      } else {
        notes.push(`其余 ${miss.length} 条只在账本里（报告写的数对得上）`);
      }
    }
  }

  // 4f. 范围清单说了没读的，报告里要能指认。
  // 判得了的只是"提没提"：点名到文件，或写出与实际相等的个数。哪一块为什么没读，仍靠读。
  if (scopeDetail && reportFile) {
    const skipped = scopeDetail.filter((e) => e.skipped).map((e) => e.path);
    if (skipped.length) {
      const flat = fs.readFileSync(path.join(dir, reportFile), 'utf8').replace(/\\/g, '/');
      const unnamed = skipped.filter((p) => {
        const base = p.split('/').pop();
        return !flat.includes(p) && !flat.includes(base);
      });
      if (unnamed.length === 0) {
        notes.push(`范围清单 ${skipped.length} 个文件标了没读，报告里逐个点到了`);
      } else {
        const D1 = /(?:未读|没读|未看|跳过|没展开)[^\d\n]{0,12}(\d+)\s*(?:个|处|块|条)/g;
        const D2 = /(\d+)\s*(?:个|处|块)[^\d\n]{0,8}(?:未读|没读|未看|跳过|没展开)/g;
        const nums = [...flat.matchAll(D1), ...flat.matchAll(D2)].map((m) => Number(m[1]));
        if (nums.includes(skipped.length)) {
          notes.push(`范围清单 ${skipped.length} 个文件标了没读（报告写了数）`);
        } else {
          const shown = unnamed.slice(0, 4).join('、');
          fail(`范围清单里 ${skipped.length} 个文件标了未读／跳过（${shown}${unnamed.length > 4 ? ' 等' : ''}），报告里既没点名、也没写出这个数——覆盖表要能让读者知道哪一块没读到，否则"读过"和"没读"在交付物上看不出区别`);
        }
      }
    }
  }

  // 5. 分路覆盖
  if (lanesFile) {
    if (!root) {
      fail('给了 --lanes 就必须同时给 --root：覆盖是按对象根算的');
    } else {
      let manifest = null;
      try {
        manifest = JSON.parse(fs.readFileSync(lanesFile, 'utf8'));
      } catch (e) {
        return { ok: false, problems: [`读不了分路清单 ${lanesFile}：${e.message}`], notes };
      }
      const exts = (manifest.extensions || ['.rs']).map((e) => e.toLowerCase());
      const claimed = new Set();
      for (const lane of manifest.lanes || []) {
        for (const f of lane.files || []) claimed.add(path.resolve(root, f));
        if (!lane.ledger) fail(`分路 ${lane.name || '?'} 没写账本路径`);
      }
      const all = walkFiles(path.resolve(root), exts);
      const uncovered = all.filter((f) => !claimed.has(f));
      if (uncovered.length) {
        const shown = uncovered.slice(0, 5).map((f) => path.relative(root, f)).join('、');
        fail(`有 ${uncovered.length} 个文件没有任何一路主责：${shown}${uncovered.length > 5 ? ' 等' : ''}`);
      }
      notes.push(`分路 ${(manifest.lanes || []).length} 路 · 对象 ${all.length} 个文件 · 有主责 ${all.length - uncovered.length} 个`);
      // 派活只能派清单内的：清单是开工前写的，派活那一刻若还能扩大范围，
      // "该看哪些"就变成由派活的人事后决定，越界那一条也就没人再审。
      if (scopeEntries && scopeEntries.length) {
        const outside = [];
        for (const f of claimed) {
          const rel = path.relative(path.resolve(root), f).replace(/\\/g, '/');
          if (!scopeMatch(rel, scopeEntries)) outside.push(rel);
        }
        if (outside.length) {
          const shown = outside.slice(0, 5).join('、');
          fail(`分路清单里有 ${outside.length} 个文件不在范围清单里：${shown}${outside.length > 5 ? ' 等' : ''}——两种读法：清单漏了这一块（补清单，并说明为什么扩），或者这一路不该派它（收回派活）。清单先写、派活只派清单内的`);
        }
      }
    }
  } else if (root) {
    // 不判失败：轻量评审本来就可以一个人读完。但把"这一项没核"和规模一起说出来，
    // 免得省掉分路这件事看起来毫无痕迹。
    const all = walkFiles(path.resolve(root));
    const n = reportFile ? collectPos(fs.readFileSync(path.join(dir, reportFile), 'utf8')).size : 0;
    notes.push(`没给 --lanes：位置来源这一项没核。对象根下 ${all.length} 个文件、报告 ${n} 处位置——这些位置是谁读的，没有分路账本可比`);
  }

  return { ok: problems.length === 0, report: reportFile, ledger: ledgerFile, problems, notes };
}

function main(argv) {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  let dir = null;
  let root = null;
  let lanesFile = null;
  let scopeFile = null;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') root = argv[++i];
    else if (a === '--lanes') lanesFile = argv[++i];
    else if (a === '--scope') scopeFile = argv[++i];
    else if (a === '--json') asJson = true;
    else if (!dir) dir = a;
    else {
      console.error(`不认识的参数：${a}`);
      return 2;
    }
  }
  if (!dir) {
    console.error(USAGE);
    return 2;
  }
  const r = runCheck({ dir, root, lanesFile, scopeFile });
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const n of r.notes) console.log(`说明 ${n}`);
    if (r.ok) console.log(`\n全部通过：${r.report}${r.ledger ? '＋' + r.ledger : ''}`);
    else {
      console.log(`\n不通过 ${r.problems.length} 项：`);
      for (const p of r.problems) console.log(`- ${p}`);
    }
  }
  return r.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
