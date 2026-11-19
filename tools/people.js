#!/usr/bin/env node
// Likely mistakes in who is who on the all-series page, to fix in docs/people.json (see docs/people.js):
//   node tools/people.js [--top 40] [--no-live] [--json]
// - one name twice in one series: the series' tracker counted two players (often a name typed in capitals once)
// - same name, other country: kept as two people because their flags differ (one person whose flag changed, or two)
// - split differently: one country, the same letters in other words ("Chengxu Hu" / "Cheng Xu Hu"), never in one series
// - one letter apart: one country, a name differing by a letter, not its first ("Weijie" / "Wenjie"): often two people
// - fixes in docs/people.json that match nobody any more
// Reads the saved archives, and the live series from their data branches (git fetch; --no-live to skip them).
// Ranked by prize money: the mistakes that move a leaderboard first.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Series = require('../docs/series.js');
const People = require('../docs/people.js');
const A = require('../docs/apt/tracker.js');
const T = require('../docs/triton/triton.js');
const G = require('../docs/glpc/glpc.js');
const { FX } = require('../docs/fx.js');

const args = process.argv.slice(2);
const top = Number(args.includes('--top') ? args[args.indexOf('--top') + 1] : 40);
const live = !args.includes('--no-live'), asJson = args.includes('--json');
const DOCS = path.join(__dirname, '../docs');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DOCS, f), 'utf8'));
const ENGINES = { apt: A, glpc: G, triton: T };

// Every source the all-series page has, in USD at a rough rate (enough to rank)
FX.seed(read('apt/archive/fx.json'));
const usd = (v, cur, d) => { const f = cur === 'USD' ? 1 : FX.factor(cur, 'USD', d); return f == null ? 0 : v * f; };
const lists = [], archived = new Set();
for (const f of read('apt/archive/index.json').series) {
  archived.add(f.id);
  const st = A.unpack(read(`apt/archive/${f.id}.json`)); A.repair(st); // as the page does
  const entry = Series.LIST.find((x) => x.org === 'apt' && x.source.series === f.id);
  lists.push({ src: 'apt:' + f.id, label: f.name, names: ['apt', f.id, entry && entry.id].filter(Boolean), rows: A.players(st, { detail: true }), rate: (v) => usd(v, f.currency, f.start) });
}
const all = read('triton/archive/all.json'); FX.seed(all.fx);
const tritonParts = [{ state: T.unpack(all) }];
if (live) {
  for (const s of Series.LIST) {
    if (Series.status(s) === 'soon' || (s.org === 'apt' && archived.has(s.source.series))) continue;
    if (s.org === 'triton' && (all.index || []).some((f) => f.id === s.source.festival)) continue;
    let st;
    try {
      execFileSync('git', ['fetch', '-q', '--depth=1', 'origin', s.branch], { stdio: 'pipe' });
      st = JSON.parse(execFileSync('git', ['show', `origin/${s.branch}:state.json`], { encoding: 'utf8', maxBuffer: 1 << 28 }));
    } catch (e) { console.warn(`${s.id}: no live record (${String(e.message).split('\n')[0]})`); continue; }
    const E = ENGINES[s.org].configure(s.source);
    if (s.org === 'triton') { tritonParts.unshift({ state: st, tag: T.festTag(st.festival.name, st.festival.startDate), start: st.festival.startDate }); continue; }
    E.repair && E.repair(st);
    lists.push({ src: s.id, label: s.name, names: [s.org, s.id], rows: E.players(st, { detail: true }), rate: (v) => usd(v, s.currency, s.start) });
  }
}
lists.push({ src: 'triton', label: 'Triton', names: ['triton'], rows: T.players(T.mergeStates(tritonParts), { detail: true }), rate: (v) => v });
for (const l of lists) l.rows = l.rows.filter((r) => r.events);

const fixes = (() => { try { return read('people.json'); } catch { return {}; } })();
const R = People.rules(fixes);
const people = People.match(lists, R);
const LBY = Object.fromEntries(lists.map((l) => [l.src, l]));
for (const p of people) {
  p.usd = Object.entries(p.rows).reduce((a, [src, r]) => a + LBY[src].rate(r.prizes || 0), 0);
  p.name = Object.values(p.rows).sort((a, b) => b.bullets - a.bullets)[0].name;
  p.where = Object.keys(p.rows).map((s) => LBY[s].label);
}
const money = (v) => '$' + (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : Math.round(v));
const who = (p) => `${p.name} (${p.cc || '??'}, ${money(p.usd)}, ${p.where.length > 3 ? p.where.length + ' series' : p.where.join(', ')})`;

// Same name key, more than one person: in one series twice, or other countries
const byKey = new Map();
for (const p of people) { const k = p.key.split('#')[0]; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(p); }
const twice = [], countries = [];
for (const [k, ps] of byKey) {
  if (ps.length < 2 || R.same.has(k) || R.apart.has(k)) continue;
  ps.sort((a, b) => b.usd - a.usd);
  const shared = ps.some((p, i) => ps.some((q, j) => j > i && (!p.cc || !q.cc || p.cc === q.cc)));
  (shared ? twice : countries).push({ key: k, people: ps, usd: ps.reduce((a, p) => a + p.usd, 0) });
}
twice.sort((a, b) => b.usd - a.usd); countries.sort((a, b) => b.usd - a.usd);

// One country, other name keys: the same letters in other words, or a letter apart
const perms = (t) => (t.length <= 1 ? [t] : t.flatMap((x, i) => perms([...t.slice(0, i), ...t.slice(i + 1)]).map((r) => [x, ...r])));
const joins = (k) => new Set(perms(k.split(' ').slice(0, 5)).map((t) => t.join('')));
const letters = (k) => k.replace(/ /g, '').split('').sort().join('');
const sig = new Map(), near = new Map();
for (const k of byKey.keys()) {
  const l = letters(k); if (l.length < 6) continue;
  if (!sig.has(l)) sig.set(l, []); sig.get(l).push(k);
  if (l.length < 9) continue;
  for (let i = 0; i <= k.length; i++) { const d = k.slice(0, i) + k.slice(i + 1); if (!near.has(d)) near.set(d, new Set()); near.get(d).add(k); }
}
// Keys a letter apart where the change is inside a word of 5 letters or more, not its first letter
const typo = (x, y) => {
  const a = x.split(' '), b = y.split(' '); if (a.length !== b.length) return false;
  const diff = a.map((w, i) => [w, b[i]]).filter(([u, v]) => u !== v); if (diff.length !== 1) return false;
  const [u, v] = diff[0]; if (Math.min(u.length, v.length) < 5 || u[0] !== v[0]) return false;
  return true;
};
const found = new Map();
const consider = (x, y, kind) => {
  if (x === y) return; if (x > y) [x, y] = [y, x];
  const id = x + '|' + y; if (found.has(id)) return;
  if (R.same.has(x) && R.same.get(x) === R.same.get(y)) return;
  for (const p of byKey.get(x)) for (const q of byKey.get(y)) {
    if (!p.cc || p.cc !== q.cc) continue;
    if (Object.keys(p.rows).some((s) => q.rows[s])) continue; // both in one series: two people (or that tracker's call)
    found.set(id, { kind, a: p.usd >= q.usd ? p : q, b: p.usd >= q.usd ? q : p, usd: p.usd + q.usd }); return;
  }
};
for (const ks of sig.values()) for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
  const J = joins(ks[i]); if ([...joins(ks[j])].some((x) => J.has(x))) consider(ks[i], ks[j], 'split');
}
for (const ks of near.values()) if (ks.size > 1) { const l = [...ks]; for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) if (typo(l[i], l[j])) consider(l[i], l[j], 'letter'); }
const split = [...found.values()].filter((x) => x.kind === 'split').sort((a, b) => b.usd - a.usd);
const letter = [...found.values()].filter((x) => x.kind === 'letter').sort((a, b) => b.usd - a.usd);

// 3. Fixes that match nobody
const keys = new Set(byKey.keys());
for (const p of people) for (const r of Object.values(p.rows)) for (const n of r.names || [r.name]) keys.add(People.norm(n));
const stale = [...(fixes.same || []).flat().filter((n) => !keys.has(People.norm(n))), ...(fixes.apart || []).map((r) => r.name).filter((n) => !keys.has(People.norm(n)))];

const groups = [
  ['One name twice in one series', 'merge with "same"', twice.map((c) => c.people)],
  ['Same name, other country', 'merge with "same" if one person', countries.map((c) => c.people)],
  ['Same letters, split differently', 'usually one person', split.map((x) => [x.a, x.b])],
  ['One letter apart', 'often two people: check before merging', letter.map((x) => [x.a, x.b])],
];
// --json: each case as its people, with every spelling, the series, and whether the name is theirs alone (a "same" fix
// merges everyone under a name, so a name shared with someone else isn't safe to merge)
const plain = (p) => { const k = p.key.split('#')[0]; return { name: p.name, key: k, names: [...new Set(Object.values(p.rows).flatMap((r) => r.names || [r.name]))], cc: p.cc, usd: Math.round(p.usd), sources: Object.keys(p.rows), where: p.where, alone: byKey.get(k).length === 1 }; };
if (asJson) { console.log(JSON.stringify({ groups: Object.fromEntries(groups.map(([t, , l]) => [t, l.slice(0, top).map((ps) => ps.map(plain))])), stale, problems: R.problems })); process.exit(0); }
console.log(`${people.length} people from ${lists.length} sources; ${(fixes.same || []).length} "same" and ${(fixes.apart || []).length} "apart" fixes in docs/people.json`);
for (const x of R.problems) console.log('people.json problem:', x);
for (const [title, hint, list] of groups) {
  console.log(`\n${title} (${list.length}, most prize money first; ${hint}):`);
  for (const ps of list.slice(0, top)) console.log(`  ${ps.map(who).join('\n    vs ')}\n    -> [${[...new Set(ps.map((p) => p.name))].map((n) => JSON.stringify(n)).join(', ')}]`);
}
console.log(`\nFixes in docs/people.json that match nobody: ${stale.length ? stale.join(', ') : 'none'}`);
