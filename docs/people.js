/*
 * One person across series, for the all-series page (docs/all/) and tools/people.js.
 *
 * Automatically: the same name in any word order, without accents, hyphens or case ("Chen Kuan-Han" = "Kuan Han Chen"),
 * at most one row per series, and countries that agree (or one is unknown).
 *
 * By hand, in docs/people.json, where that gets it wrong:
 *   "same":  [["Kuan-Han Chen", "Chen Kuanhan"], ...]
 *            names that are one person: merged whatever their countries, also two rows of one series. One name
 *            alone (["Daniel Smiljkovic"]) merges everyone under it: one person whose flag differs between series
 *   "apart": [{ "name": "Wei Zhang", "people": [["apt"], ["triton", "glpc-vi"]] }, ...]
 *            one name, several people: each list is the series of one of them. A series is named by its id in
 *            docs/series.js, a past APT series by its slug, "triton" for every Triton festival, or an organiser
 *            (apt, glpc, triton) for all of its series. Series not listed go with the first person.
 * tools/people.js lists likely cases of both.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.People = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const normMemo = new Map();
  const norm = (n) => { let k = normMemo.get(n); if (k === undefined) { k = norm0(n); if (normMemo.size < 500000) normMemo.set(n, k); } return k; };
  const norm0 = (n) => String(n).replace(/[đĐ]/g, 'd').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).sort().join(' ');

  // docs/people.json -> lookups by name key
  function rules(json) {
    const same = new Map(), apart = new Map(), problems = [];
    for (const group of (json && json.same) || []) {
      if (!Array.isArray(group) || !group.length) { problems.push(`same: ${JSON.stringify(group)} needs a name`); continue; }
      const keys = group.map(norm), to = keys.map((k) => same.get(k)).find(Boolean) || keys[0];
      for (const k of keys) same.set(k, to);
    }
    for (const r of (json && json.apart) || []) {
      if (!r || !r.name || !Array.isArray(r.people) || r.people.length < 2) { problems.push(`apart: ${JSON.stringify(r)} needs a name and two lists of series`); continue; }
      apart.set(norm(r.name), r.people.map((l) => new Set([].concat(l))));
    }
    return { same, apart, problems };
  }

  // Two rows of one series that are one person (spelled two ways there)
  function mergeRow(a, b) {
    const main = (b.bullets || 0) > (a.bullets || 0) ? b : a, out = { ...main };
    for (const k of ['events', 'bullets', 'reentries', 'busts', 'buyins', 'prizes', 'net', 'cashes', 'cashedEvents', 'wins']) out[k] = (a[k] || 0) + (b[k] || 0);
    out.cc = a.cc || b.cc; out.partial = !!(a.partial || b.partial);
    out.ev = [...(a.ev || []), ...(b.ev || [])];
    out.seatedIn = [...(a.seatedIn || []), ...(b.seatedIn || [])];
    out.lastBust = Math.max(a.lastBust || 0, b.lastBust || 0) || null;
    out.itm = out.bullets ? out.cashes / out.bullets : 0;
    out.itmEvent = out.events ? out.cashedEvents / out.events : 0;
    out.names = [...new Set([...(a.names || [a.name]), ...(b.names || [b.name])])];
    return out;
  }

  // lists: [{ src: id, names: [what docs/people.json may call it], rows: [player rows] }] -> [{ key, cc, rows: { src: row } }]
  function match(lists, R) {
    R = R || rules(null);
    const people = [], byKey = new Map();
    for (const { src, names, rows } of lists) {
      const called = new Set([src, ...(names || [])]);
      for (const r of rows) {
        const k0 = norm(r.name), forced = R.same.has(k0);
        let key = forced ? R.same.get(k0) : k0;
        const split = R.apart.get(key);
        if (split) { const i = split.findIndex((set) => [...called].some((n) => set.has(n))); key += '#' + Math.max(0, i); }
        if (!byKey.has(key)) byKey.set(key, []);
        const list = byKey.get(key);
        let p;
        if (forced || split) p = list[0]; // named by hand: one person whatever the countries
        else p = list.find((x) => !x.rows[src] && (!x.cc || !r.cc || x.cc === r.cc));
        if (!p) { p = { key, cc: '', rows: {} }; list.push(p); people.push(p); }
        p.rows[src] = p.rows[src] ? mergeRow(p.rows[src], r) : r;
        if (!p.cc && r.cc) p.cc = r.cc;
      }
    }
    return people;
  }

  return { norm, rules, match, mergeRow };
});
