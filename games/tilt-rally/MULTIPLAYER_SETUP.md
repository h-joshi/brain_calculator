# Tilt Rally multiplayer setup

1. Create a Supabase project.
2. Apply the SQL files in `supabase/migrations/` in numeric order using the SQL editor (or `supabase db push`). For a project that already has multiplayer installed, apply only migrations it has not run; do not rerun `001_multiplayer.sql`.
3. In Realtime settings, leave public channels enabled. Channel names contain a per-room random secret and no database rows are exposed.
4. Copy the project URL and publishable key into `supabase-config.js`. A legacy anonymous key also works. These keys are designed for browser use; never place a secret or service-role key in this repository.
5. In Supabase Cron, schedule `select public.cleanup_tilt_rooms();` hourly.
6. Deploy the static files to GitHub Pages as usual.

For local testing, serve the directory over HTTP rather than opening the HTML file directly:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/games/tilt-rally/` in two browser sessions. Motion controls require HTTPS on physical devices, so use the deployed GitHub Pages URL for phone testing.

The join screen lists unexpired rooms that are waiting for a second player. It exposes only the room code, host display name, creation time, and player count; passwords and room channel secrets remain private.
