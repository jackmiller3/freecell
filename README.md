# FreeCell

A clean, fast FreeCell built for the iPhone (Pro Max included), with no dependencies and no build step.

- **Only winnable deals.** Every deal is run through a solver before you see it. Unwinnable deals (like the classic #11982) are skipped.
- **Hints.** Hint highlights a move that keeps the game winnable. Tap Hint again to play it.
- **Rewind.** Rewind takes you back to the last position that could still be won. If you'd like to know as soon as a game turns unwinnable, a setting makes the Rewind button light up at that point.
- **Tap or drag.** Tap a card to send it to the best spot, or drag it exactly where you want it. Safe cards go up to the foundations automatically. Once the rest of the game plays itself, it finishes on its own.
- Daily deal, play any deal by number (Microsoft-compatible numbering, 1–1,000,000), stats and streaks, four-color suits, table colors.
- Your game is saved, so you pick up where you left off. It also works offline once you've added it to your Home Screen.

## Run locally

```sh
npm start          # or any static file server
open http://localhost:8000
```

## Put it on your phone

The repo deploys to GitHub Pages through `.github/workflows/pages.yml`. To turn it on, go to the repo's **Settings → Pages** and set **Source** to **GitHub Actions**. Then open the site in Safari and use **Share → Add to Home Screen** to get a full-screen app.

## How it works

| File | What it does |
| --- | --- |
| `js/engine.js` | Rules: Microsoft deal generator, legal moves, supermove capacity, safe auto-play |
| `js/solver.js` | Best-first search with transposition table. Each edge is one player move plus auto-play, so a solution's first move is directly usable as a hint. The move set is complete, so an exhausted search proves the position is lost. |
| `js/solver-worker.js` | Runs the solver off the main thread, both for dealing and for analysing positions |
| `js/app.js` | UI: rendering, tap/drag input, hints, rewind, persistence |

Rewind relies on a simple fact: along a line of play, winnability can only go from "yes" to "no". So the app binary-searches your move history for the last winnable position. Background analysis after each move feeds the lost-position warning and makes hints instant.

## Tests

```sh
npm test   # solves and replays deals #1–1000, and checks that #11982 is proven unwinnable
```
