# APT Taipei 2026 live tracker

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
   After that it runs on its own (each job polls for ~55 min; the schedule queues the next one).
5. Open `https://<owner>.github.io/<repo>/`.

To stop after the series, disable the workflow in the Actions tab.

## Local run

```bash
node poller/poll.js --state state/state.json --minutes 10 --interval 60 --no-publish
```
