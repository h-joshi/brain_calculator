# Tilt Rally multiplayer setup

1. Create a Supabase project.
2. Apply `supabase/migrations/001_multiplayer.sql` in the SQL editor (or with `supabase db push`).
3. In Realtime settings, leave public channels enabled. Channel names contain a per-room random secret and no database rows are exposed.
4. Copy the project URL and public anonymous key into `supabase-config.js`. The anonymous key is designed to be public; never place a service-role key in this repository.
5. In Supabase Cron, schedule `select public.cleanup_tilt_rooms();` hourly.
6. Deploy the static files to GitHub Pages as usual.

For local testing, serve the directory over HTTP rather than opening the HTML file directly:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/tilt-rally.html` in two browser sessions. Motion controls require HTTPS on physical devices, so use the deployed GitHub Pages URL for phone testing.
