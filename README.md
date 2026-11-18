# Live poker series trackers

Real-time bust and re-entry tracking for live poker series (APT, GLPC, Triton so far), built on each organiser's
public live data, plus an all-series page that matches players across every series.

- **Pages** (`docs/`, served by GitHub Pages): one page per organiser (`docs/apt/`, `docs/glpc/`, `docs/triton/`)
  with a bust feed, live event cards and a player table (bullets, buy-ins, prizes, net, ITM %); a home page; and
  `docs/all/`, every player across every series.
- **Poller** (`poller/`, run by GitHub Actions): polls each running series around the clock and saves its record to the
  series' data branch as `state.json`, so a page has full history when you open it.
- **Series list** (`docs/series.js`): every series in one place. Pages, home banners, footer links, the all-series page
  and the poller all read it.

## Adding a series

**Same organiser** (the next APT stop, GLPC VII, a new Triton festival): add one entry to `LIST` in `docs/series.js`,
copying one of that organiser's and changing:

- `id` (never change it later), `branch` (a new data branch name, e.g. `apt-manila-2027-data`)
- `name`, `tag`, `place`, `tz`, `currency`, `start`, `end` (venue dates), `link`
- the banner fields (`title`, `mark`, `sub`, `art`, `watermark`)
- `source`, what the engine needs to find it:
  - APT: `{ series: '<slug from theasianpokertour.com/series/<slug>>' }`
  - GLPC: `{ series, seriesUrl, from, to }` (the tournaments listed between those dates)
  - Triton: `{ festival: '<festival id from tritonpoker.plus/festival/<id>>', series }`

Then run `tools/stamp.sh` and push. The *Poll series* workflow starts polling it the day before it starts, and stops two days after it
ends. To start it earlier, run that workflow by hand with the series id. Its page is
`<organiser page>?s=<id>`; the organiser's page without `?s=` shows its running series (else the next, else the latest).
A Triton festival also joins the Triton all-time view, and the all-series page picks every series up by itself. Once a Triton festival
has ended, `node tools/triton-archive.js` moves it into the archive.

**New organiser**: write an engine `docs/<org>/<org>.js` with the same interface as the others: `configure(source)`,
`emptyState`, `pollOnce`, `repair`, `players(state, { detail, fromStart, finished })`, `playerTimeline`,
`completedEvents`, `liveEvents`, `upcoming`, `eventFinished`, `watchedFromStart`, `eventPlayers` and `canon`.
Copy the closest page into `docs/<org>/index.html` and point it at the new engine. Add the organiser to `ORGANISERS` in
`docs/series.js` (with `poll` pace), and add a `<script>` for the engine to `docs/all/index.html` and a line to
`tools/stamp.sh`. If its events read differently (flights, later days, currency per event), add an `ADAPT` entry in
`docs/all/all.js`. Then add its series as above.

## How busts and re-entries are detected

The site lists who is seated in each running event, but not who busted or how many bullets they fired.
Consecutive snapshots are compared:

| Seen | Recorded as |
| --- | --- |
| A player's seat disappears | Bust, at the time of that poll |
| A busted player sits down again | Re-entry (bullet + 1) |
| A player reappears in the same seat within a few polls | Data glitch, the bust is undone |
| A new name appears | New entry |

`Untracked` on an event card = official entries − bullets seen. It covers bullets fired before tracking
began and bust + re-entry faster than one poll. Chip counts on the site are not live, so they are not used.

## Setup

1. Make this repository **public** (needed for free Actions minutes and Pages).
2. **Settings → Pages**: Source *Deploy from a branch*, branch `main`, folder `/docs`.
3. **Settings → Actions → General → Workflow permissions**: *Read and write permissions*.
4. Nothing to start by hand. The *Poll series* workflow (`.github/workflows/poll.yml`) runs every 15 minutes and starts a
   poller for each series in its dates. Each poller job polls for ~5 h 45 min. When it starts, it queues the next run
   of its series, which waits in that series' concurrency group and takes over the moment it ends. The schedule is only a
   backup. Queueing stops two days after the series ends, or once every event has finished.
5. Open `https://<owner>.github.io/<repo>/` (home).

To pause everything, disable the workflow in the Actions tab.

## Changing the engine

After editing an engine, `docs/fx.js`, `docs/series.js` or `docs/all/all.js`, run `tools/stamp.sh`. It points each
page at its scripts by content hash (`tracker.js?v=<hash>`), so phones never combine a new page with a cached old engine.

## Local run

```bash
node poller/poll.js --series apt-taipei-2026 --state state/state.json --minutes 10 --no-publish
```

## GLPC VI (Grand Loyal Poker Championships, 18–29 Nov 2026)

A second tracker with the same views lives in `docs/glpc/` (page at `https://<owner>.github.io/<repo>/glpc/`),
built on the public JSON behind grandloyal.vn's tracker (`apitracker.grandloyal.vn`, the requests its own pages make).

- Engine: `docs/glpc/glpc.js`, record on the `glpc-data` branch (series `glpc-vi`).
- The site lists everyone who registered for an event, each with a player id and a busted flag, plus official entry
  and rebuy counts. A flip to busted is a bust; back in (or the same name registering again) is a re-entry once the
  entry count has gone up. Official rebuys we could not attach to a player show as *missed*.
- Places come from the leaderboard rank, prizes from the payout table (stored by the site in thousands of VND).
- Times from the site are Vietnam wall-clock time with a `Z` suffix; the engine converts them to UTC.
- Later days get their event number from the flights that feed them (`multiDayTourId`); the schedule's reused
  numbers for different single-day events (#14/#15/#16 on 20 and 21 Nov) are kept apart as `#14·2` etc.

## Triton N. Cyprus 2026 (15–30 Nov 2026)

`docs/triton/` (page at `https://<owner>.github.io/<repo>/triton/`), built on the public GraphQL API the
Triton Poker+ app loads (`prod-public-serverless.triton-poker.com/graphql`, no login).

- Engine: `docs/triton/triton.js`, record on the `triton-data` branch (series `triton-n-cyprus-2026`), saved every 2 minutes.
- The API lists every participant with their buy-in transactions (bullets), alive flag, latest bust time and live chips,
  and payouts name the player in each place, so bullets, buy-ins and prizes are exact. Re-entry times come from polling.
- The API only allows pages on tritonpoker.plus (CORS), so the page cannot poll it. It reads the poller's saves instead:
  it asks GitHub's API for the branch's latest commit (an unchanged answer costs nothing against the rate limit) and
  fetches `state.json` at that commit, which avoids the raw host's 5-minute cache.
- Buy-ins use the amount in each event's name (the schedule's `buyIn` field is stale for some upcoming events).

## Home page and layout

`docs/index.html` is the home page: one banner per tracked series under *Running now*, *Coming up* or *Past*
(by the series dates in its venue's time zone), with live counts from each tracker's `meta.json` (events running and
finished, players, bullets, prizes paid). The banners come from `docs/series.js`; each page's title links home.

## Past Triton festivals and all-time view

`node tools/triton-archive.js` saves every finished Triton tournament festival (2018 onwards) to
`docs/triton/archive/<festival id>.json` plus `index.json`. Run it again only to add a festival that has since ended
(`--only <id>`, `--force` to refetch; `--merge` only rebuilds `all.json`). The Triton page shows one with `?f=<festival id>`
and all of them together, plus the festivals in `docs/series.js` not archived yet, with `?view=all`; the home page lists
them under Past.

The tool also writes `archive/all.json`: every archived festival already merged, as one file (~470 KB gzipped, versus 28 files),
with the exchange rates for those dates included. Profile ids are shortened to 8 characters in one name → id table.
The all-time view loads it in one request, with no merging or rate requests in the browser, and is ready in about a second.

- Every festival has players, entries, named payouts and each player's final bust time. Bullets per player come from the
  participants' `noOfEntries` field (served by the API though the Triton+ app doesn't request it; the same numbers
  MTTDB.com publishes) and, from Sep 2026, buy-in transactions. They add up to the official entries in most events since
  2019; Triton One multi-flight events list only part of the field and 2018–19 are incomplete, so those show a minimum (≥).
  A count summing far above the entries (one event) is ignored.
- Buy-ins are what players pay, read from the event name or the listed amount when that is the name's amount plus fee
  (Triton's own transaction amounts leave the fee out).

## Currency switch

Every tracker has a currency menu at the top (remembered across the trackers). `docs/fx.js` converts each amount at the
rate of its own date — a buy-in at the event's start, a prize at its finish — using ECB rates via Frankfurter (history back
to 1999) and, for TWD and VND, daily rates on jsDelivr (from March 2024; earlier dates use the first available day).
Rates are cached in the browser. The all-time Triton view always picks one currency (USD by default).

## Data checks (rules added after an audit)

- APT: re-entries are capped by the event's limit from its name (Freezeout = 1 bullet, "1 Re-Entry" = 2, "2 Re-Entry" = 3);
  a return past the limit is a seat move or glitch. Saved history is repaired the same way. "All bullets known" also counts
  an event whose bullets seen reach the official entries (e.g. a freezeout where every entrant was seen).
- GLPC: a return is a re-entry only if the entry count rose since that player's bust and an official rebuy is still unclaimed.
  "All bullets known" also counts events where every official rebuy is attached to a player.
- Triton: event start = the event's own start date (the day list sometimes holds only Day 2), the venue's time zone when
  Triton's is missing or wrong, never after the first bust. Pre-2020 bust times are a placeholder (21 Apr 2021) and are ignored.
- ITM % on players is per bullet (cashes / bullets); the panel also shows it per event.

## APT registration lists

Each APT event has an unlinked page, `/series/<series>/events/<id>/players`, listing everyone registered (name and
country, no entry counts). The poller reads it every 2 minutes while an event runs and once when it finishes (including
events that finished before tracking began), and adds every registered player never seen at a table with one bullet.
Later days list that day's players, so a Final Day player found in an earlier flight counts as carried over.
"All bullets known" on APT means the bullets counted (seen, re-entries seen, registered) add up to the official entries
within 2 or 1%; elsewhere unattributed re-entries make players' bullets a minimum. A finished multi-flight event's panel
shows every flight's players with bullets summed.

## All series (`docs/all/`)

Every player and event the trackers hold, across every series in `docs/series.js` and every Triton festival:

- **Players**: one row per person with bullets, buy-ins, prizes, net and ITM % summed across series, tags for the series they
  played, a summary (also split by series), and filters by organiser, year, finished events and all bullets known. The
  panel shows the person's totals, a table by series (each row opens the player in that series' tracker), a bankroll chart
  over every event, and every event they played.
- **Events**: every event of every series, newest first (or by buy-in, entries or prize pool); each opens in its own tracker.
- Each series is counted by its own engine (`players(state, { detail: true })` lists every player's events with bullets,
  buy-in and prize); the page converts the amounts to one currency at each date's rate.
- Series don't share player ids, so a person is matched by name in any word order, ignoring accents, hyphens and case
  ("Chen Kuan-Han" = "Kuan Han Chen"), and only when the countries agree or one is missing. About 150 players appear in more
  than one series. Same-name players from the same country are merged, and different spellings stay apart.
- Tracker pages open a player or event from a link: `?player=<name>`, `?event=<event id>`.
