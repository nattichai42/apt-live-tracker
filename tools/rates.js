// Exchange rates saved next to an archive (docs/<org>/archive/fx.json), so pages convert past series without asking
// for hundreds of days of rates: units per USD for each day of each saved series (a day before to three after).
// ECB rates (Frankfurter) for KRW, PHP, ..., and the daily jsDelivr files for TWD and VND, which the ECB doesn't publish
// (from 2 March 2024; earlier days use that one). The file only grows: days already saved aren't asked for again.
'use strict';
const fs = require('fs');
const path = require('path');
const FX = require('../docs/fx.js').FX;

const fetchFn = (url) => fetch(url, { headers: { 'User-Agent': 'apt-live-tracker (archive)', Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// dir: the archive folder; series: [{ start, end }] ('YYYY-MM-DD')
async function writeRates(dir, series) {
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, 'fx.json');
  let table = {}; try { table = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const have = (d, c) => table[d] && table[d][c] > 0;
  const put = (d, c, v) => { if (v > 0) (table[d] || (table[d] = {}))[c] = v; };
  const ecb = FX.LIST.filter((c) => c !== 'USD' && FX.ECB.has(c));
  const days = new Set();
  for (const f of series) {
    let need = false;
    for (let d = shift(f.start, -1); d <= shift(f.end, 3) && d <= today; d = shift(d, 1)) {
      const day = new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay();
      if (day && day < 6 && !ecb.every((c) => have(d, c))) need = true; // the ECB publishes on weekdays
      const j = d < '2024-03-02' ? '2024-03-02' : d;
      if (!have(j, 'TWD')) days.add(j);
    }
    if (!need) continue;
    const r = await fetchFn(`https://api.frankfurter.dev/v1/${shift(f.start, -7)}..${shift(f.end, 7)}?base=USD&symbols=${ecb.join(',')}`);
    if (r.ok) for (const [d, x] of Object.entries((await r.json()).rates || {})) for (const [c, v] of Object.entries(x)) put(d, c, v);
    await sleep(150);
  }
  const list = [...days].sort(); let i = 0;
  const work = async () => { while (i < list.length) { const d = list[i++];
    try {
      const r = await fetchFn(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${d}/v1/currencies/usd.min.json`);
      if (r.ok) { const u = (await r.json()).usd || {}; put(d, 'TWD', u.twd); put(d, 'VND', u.vnd); }
    } catch {} } };
  await Promise.all([work(), work(), work(), work()]);
  fs.writeFileSync(file, JSON.stringify(table));
  console.log(`${path.relative(path.join(__dirname, '..'), file)}: ${Object.keys(table).length} days (${list.length} asked for), ${Math.round(fs.statSync(file).size / 1024)} KB`);
}
module.exports = { writeRates };
