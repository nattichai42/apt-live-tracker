# APT Taipei 2026, GLPC VI and Triton N. Cyprus live trackers

Real-time bust and re-entry tracking for the APT Championship Taipei 2026, built on the public
live-seating data of theasianpokertour.com.

- **Live page** (`docs/`, served by GitHub Pages): polls the APT site from your browser every 30–60 s,
  shows a bust feed, live event cards, and a player table (bullets, buy-ins, prizes, net, ITM %).
- **Poller** (`poller/`, run by GitHub Actions): does the same polling around the clock and saves the
  record to the `data` branch as `state.json`, so the live page has full history when you open it.

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
4. **Actions** tab → *Poll APT live seating* → *Run workflow* to start the first run.
   After that it runs on its own: each job polls every 60 s for ~5 h 45 min and, when it starts, queues the
   next run, which takes over the moment it ends. The cron schedule is only a backup. Queueing stops once
   every event in the series is completed.
5. Open `https://<owner>.github.io/<repo>/` (home) or `/apt/` for this tracker.

To stop after the series, disable the workflow in the Actions tab.

## Changing the engine

After editing `docs/apt/tracker.js`, `docs/glpc/glpc.js` or `docs/triton/triton.js`, run `tools/stamp.sh`. It points each page at its engine by content hash (`tracker.js?v=<hash>`),
so phones never combine a new page with a cached old engine.

## Local run

```bash
node poller/poll.js --state state/state.json --minutes 10 --interval 60 --no-publish
```

## GLPC VI (Grand Loyal Poker Championships, 18–29 Nov 2026)

A second tracker with the same views lives in `docs/glpc/` (page at `https://<owner>.github.io/<repo>/glpc/`),
built on the public JSON behind grandloyal.vn's tracker (`apitracker.grandloyal.vn`, the requests its own pages make).

- Engine: `docs/glpc/glpc.js`. Workflow: *Poll GLPC live tracker* (`.github/workflows/glpc-poll.yml`), record on the
  `glpc-data` branch. Start it once from the Actions tab (*Run workflow*); it queues its own successors until 1 Dec.
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

- Engine: `docs/triton/triton.js`. Workflow: *Poll Triton N. Cyprus* (`.github/workflows/triton-poll.yml`), record on
  the `triton-data` branch, saved every 2 minutes. Start it once from the Actions tab; it queues its own successors.
- The API lists every participant with their buy-in transactions (bullets), alive flag, latest bust time and live chips,
  and payouts name the player in each place, so bullets, buy-ins and prizes are exact. Re-entry times come from polling.
- The API only allows pages on tritonpoker.plus (CORS), so the page cannot poll it. It reads the poller's saves instead:
  it asks GitHub's API for the branch's latest commit (an unchanged answer costs nothing against the rate limit) and
  fetches `state.json` at that commit, which avoids the raw host's 5-minute cache.
- Buy-ins use the amount in each event's name (the schedule's `buyIn` field is stale for some upcoming events).

## Home page and layout

`docs/index.html` is the home page: one banner per tracked series under *Running now*, *Coming up* or *Past*
(by the series dates in its venue's time zone), with live counts from each tracker's `meta.json` (events running and
finished, players, bullets, prizes paid). Trackers live at `docs/apt/`, `docs/glpc/` and `docs/triton/`; each page's title
links home. To add a series, add its tracker and one entry to `SERIES` in `docs/index.html`.

## Past Triton festivals and all-time view

`node tools/triton-archive.js` saves every finished Triton tournament festival (2018 onwards) to
`docs/triton/archive/<festival id>.json` plus `index.json`. Run it again only to add a festival that has since ended
(`--only <id>`, `--force` to refetch). The Triton page shows one with `?f=<festival id>` and all of them together, plus the
live festival, with `?view=all`; the home page lists them under Past.

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
