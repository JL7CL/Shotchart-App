# Basketball Shot Chart — Offline iPad PWA

This is the offline-first successor to the Streamlit shot-chart app. It runs entirely in the browser after installation and does not need Python, Streamlit, or an internet connection during a game.

## What works in this first offline build

- Installable Home Screen app in landscape mode
- Touch shot chart with make/miss markers
- 2PT, 3PT, and continuous free-throw entry
- Optional assist entry after a made basket
- OREB, DREB, personal fouls, and turnovers
- Five-player on-court lineups and substitutions
- Quarters, halves, and OT1–OT3
- Configurable game clock with start, pause, reset, and corrections
- Score, team fouls, timeouts, and optional overtime timeouts
- General Undo
- Separate Game Log with event editing and deletion
- Team and player statistics
- Automatic IndexedDB saving and crash recovery
- JSON export/import backups
- Service-worker caching for offline use

The original Streamlit file is intentionally not modified or required by this project.

## Run it locally on a Mac

A service worker requires an HTTP origin; do not open `index.html` directly as a `file://` URL.

From this folder, run:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` in Safari or Chrome on the Mac.

## Install on an iPad

For the iPad installation, the project must be served once from an HTTPS address. Static hosts such as GitHub Pages, Cloudflare Pages, or Netlify work because this project has no server and no secrets.

1. Publish the contents of this folder to an HTTPS static site.
2. Open that address in Safari on the iPad while connected.
3. Tap **Share → Add to Home Screen → Add**.
4. Open ShotChart from the Home Screen once.
5. Turn on Airplane Mode and verify that it opens and records a test shot.

After installation, all live game data is stored on the iPad. Export a JSON backup after important games because deleting the app or clearing Safari website data can remove local data.

## Updating the app

When files change, update `CACHE_NAME` in `sw.js` (for example, `shotchart-shell-v2`) before publishing. The next connected launch downloads the new app shell; recorded game data remains in IndexedDB.

## Project files

- `index.html` — app screens and court SVG
- `styles.css` — responsive iPad interface
- `app.js` — game rules, controls, event model, statistics, and editing
- `db.js` — IndexedDB autosave and recovery
- `sw.js` — offline cache
- `manifest.webmanifest` — installation metadata
- `icons/` — Home Screen icons

## Next conversion steps

1. Add a completed-games library and reopen workflow (Phase 2).
2. Add PDF/CSV reports using browser-side generation.
3. Add automated browser tests for every scoring and Undo path.
4. Optionally wrap this same PWA with Capacitor for TestFlight/App Store distribution.
