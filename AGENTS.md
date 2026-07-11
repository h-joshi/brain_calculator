# Repository Guidelines

## Project overview

Brain Arcade is a static, mobile-first collection of browser games deployed to GitHub Pages. There is no package manager or build step. `index.html` is the launcher; the self-contained Brain Score Calculator is in `games/brain-score-calculator/`; and Tilt Rally is in `games/tilt-rally/`. Multiplayer support uses the public Supabase JavaScript client and the SQL migration under the Tilt Rally directory.

## Development workflow

- Serve the repository over HTTP with `python3 -m http.server 8000`, then open `http://localhost:8000/`. Do not rely on `file://` URLs.
- Motion controls require a secure context and explicit user permission. Test them on the deployed HTTPS site using current mobile Safari and Chrome in landscape orientation.
- There is no automated test suite. For each change, run `git diff --check`, parse or syntax-check changed JavaScript/HTML, and manually exercise the affected flow.
- For Tilt Rally, verify solo tilt, touch, keyboard controls, calibration, scoring, local best score, rotation prompts, and audio. Multiplayer changes also require two browser sessions and the cases listed in `games/tilt-rally/MULTIPLAYER_SETUP.md` or the relevant task.

## Code conventions

Use plain HTML, CSS, and modern browser JavaScript; avoid introducing a framework or build dependency without a clear need. Match nearby formatting: two-space indentation in HTML/CSS/JavaScript, single-quoted JavaScript strings, `camelCase` functions and variables, and `UPPER_SNAKE_CASE` constants. Keep UI state transitions explicit and keep canvas/game logic separate from room/network logic. Preserve mobile safe-area handling, responsive layouts, accessibility labels, reduced-motion behaviour, and desktop keyboard fallbacks.

Tilt Rally's multiplayer host is authoritative for physics, collisions, scores, and match completion. Guests send paddle input only. Keep message sequence and match checks intact so delayed or stale broadcasts cannot roll state backwards.

## Supabase and security

Apply `games/tilt-rally/supabase/migrations/001_multiplayer.sql` through the Supabase SQL editor or CLI. Keep privileged data behind token-validated `security definer` RPCs and deny direct anonymous table access. Password hashes, service-role keys, and other secrets must never reach browser code or git. `games/tilt-rally/supabase-config.js` may contain only the public project URL and anonymous key; keep `games/tilt-rally/supabase-config.example.js` aligned with its shape. Follow `games/tilt-rally/MULTIPLAYER_SETUP.md` for deployment and cleanup scheduling.

## Deployment and review

`.github/workflows/deploy-pages.yml` publishes an explicit file list from `main`. Whenever a runtime file is added, renamed, or split out, update the workflow's `Prepare static site` copy list and verify every linked asset is present in `_site`. Check launcher links, including the URL-encoded filename containing spaces.

Keep commits focused and use short imperative subjects consistent with history, such as `Improve Tilt Rally mobile controls`. Do not stage, discard, or overwrite unrelated working-tree changes. Pull requests should describe player-visible behaviour, list manual checks, and include screenshots or recordings for UI changes. Treat production Supabase migration and live two-device testing as explicit follow-up items when credentials or infrastructure are unavailable.
