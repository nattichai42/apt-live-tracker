/*
 * Exchange rates for the trackers' currency switch: every amount is converted at the rate of its own date
 * (a buy-in at the event's start, a prize at its finish).
 *
 * Sources (both free, no key, open to any page):
 *   - European Central Bank reference rates via Frankfurter (api.frankfurter.dev): history back to 1999 for
 *     USD, EUR, GBP, HKD, THB, JPY, KRW, CNY, SGD, AUD, MYR, PHP, INR, CAD and more. Business days only, so a
 *     weekend uses the Friday rate.
 *   - Daily rates on jsDelivr (@fawazahmed0/currency-api) for currencies the ECB doesn't publish: TWD and VND.
 *     Available from 2 March 2024; earlier dates use that first day's rate.
 * Rates are kept per day as "units per 1 USD" and cached in this browser.
 */
(function (root) {
  'use strict';
  const ECB = new Set('USD EUR JPY BGN CZK DKK GBP HUF PLN RON SEK CHF ISK NOK TRY AUD BRL CAD CNY HKD IDR ILS INR KRW MXN MYR NZD PHP SGD THB ZAR'.split(' '));
  const LIST = ['USD', 'EUR', 'GBP', 'THB', 'TWD', 'VND', 'HKD', 'CNY', 'JPY', 'KRW', 'SGD', 'AUD', 'MYR', 'PHP', 'INR', 'CAD'];
  const JSD_FIRST = '2024-03-02';
  const KEY = 'fx-rates-v1', PREF = 'fx-currency';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  let table = {}; // 'YYYY-MM-DD' -> { CUR: units per USD }
  try { table = JSON.parse(store.get(KEY) || '{}') || {}; } catch { table = {}; }
  const save = () => store.set(KEY, JSON.stringify(table));

  const ymd = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
  const today = () => new Date().toISOString().slice(0, 10);
  const shift = (d, days) => new Date(Date.parse(d + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  const put = (d, cur, v) => { if (!(v > 0)) return; (table[d] || (table[d] = {}))[cur] = v; };

  // Units of `cur` per USD near date d (a future date uses today's): that day, else the closest earlier day
  // within a week, else a later one. Unless strict, fall back to the nearest day known at all (approximate).
  function perUsd(cur, d, strict) {
    if (cur === 'USD') return 1;
    const t = today(); if (d > t) d = t;
    if (!ECB.has(cur) && d < JSD_FIRST) d = JSD_FIRST;
    for (let i = 0; i <= 7; i++) { const x = table[shift(d, -i)]; if (x && x[cur]) return x[cur]; }
    for (let i = 1; i <= 7; i++) { const x = table[shift(d, i)]; if (x && x[cur]) return x[cur]; }
    if (strict) return null;
    let best = null, gap = Infinity;
    for (const [day, x] of Object.entries(table)) if (x[cur]) { const g = Math.abs(Date.parse(day) - Date.parse(d)); if (g < gap) { gap = g; best = x[cur]; } }
    return best;
  }
  const have = (cur, d) => perUsd(cur, d, true) != null;

  // Load whatever is missing for these dates ('YYYY-MM-DD') and currencies
  async function ensure(dates, currencies) {
    const t = today();
    dates = [...new Set(dates.filter(Boolean).map((d) => (d > t ? t : d)))].sort();
    const curs = [...new Set(currencies)].filter((c) => c && c !== 'USD');
    const ecb = curs.filter((c) => ECB.has(c)), other = curs.filter((c) => !ECB.has(c));
    let changed = false;
    // ECB: one request per run of nearby dates
    const needE = dates.filter((d) => ecb.some((c) => !have(c, d)));
    const runs = [];
    for (const d of needE) { const last = runs[runs.length - 1]; if (last && Date.parse(d) - Date.parse(last[1]) <= 45 * 86400000) last[1] = d; else runs.push([d, d]); }
    let k = 0;
    const runE = async () => { while (k < runs.length) { const [a, b] = runs[k++];
      try {
        const r = await fetch(`https://api.frankfurter.dev/v1/${shift(a, -7)}..${b}?base=USD&symbols=${ecb.join(',')}`);
        if (!r.ok) continue;
        const j = await r.json();
        for (const [d, rates] of Object.entries(j.rates || {})) for (const [c, v] of Object.entries(rates)) put(d, c, v);
        changed = true;
      } catch {} } };
    await Promise.all([runE(), runE(), runE(), runE()]);
    // TWD, VND...: one small file per day
    if (other.length) {
      const days = [...new Set(dates.map((d) => (d < JSD_FIRST ? JSD_FIRST : d)))].filter((d) => other.some((c) => !table[d] || !table[d][c]));
      let i = 0;
      const work = async () => { while (i < days.length) { const d = days[i++];
        for (let back = 0; back < 4; back++) { // today's file may not be out yet
          const day = shift(d, -back);
          try {
            const r = await fetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.min.json`);
            if (!r.ok) continue;
            const u = (await r.json()).usd || {};
            for (const c of other) put(d, c, u[c.toLowerCase()]);
            changed = true; break;
          } catch {}
        } } };
      await Promise.all([work(), work(), work(), work()]);
    }
    if (changed) save();
    return changed;
  }

  // Multiply an amount in `from` on date d by this to get `to`; null when a currency has no rate at all yet
  function factor(from, to, d) {
    if (!from || !to || from === to) return 1;
    const a = perUsd(from, d), b = perUsd(to, d);
    return a && b ? b / a : null;
  }
  // Is there a rate within a week of d for both (else factor() used the nearest day known)?
  const exact = (from, to, d) => !from || !to || from === to || (have(from, d) && have(to, d));

  const pick = () => store.get(PREF) || '';
  const choose = (c) => store.set(PREF, c || '');

  root.FX = { LIST, ECB, ensure, factor, exact, perUsd, ymd, pick, choose };
})(typeof self !== 'undefined' ? self : this);
