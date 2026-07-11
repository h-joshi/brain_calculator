# Development environment

The repository includes a VS Code dev container with Node.js 22, Python 3 and
Chromium. Install Docker, VS Code and the **Dev Containers** extension, open the
repository, then run **Dev Containers: Reopen in Container**. Dependencies are
installed automatically with `npm install`.

## Common commands

- `npm run dev` serves the site at <http://localhost:8000/>.
- `npm run check` validates HTML, CSS and JavaScript.
- `npm test` starts a temporary server and runs desktop and landscape-mobile
  Chromium smoke tests.
- `npm run test:headed` shows the browser while the tests run.
- `npm run test:ui` opens Playwright's interactive test runner.

The automated tests cover basic loading and navigation. Motion permissions,
device orientation, audio, calibration and two-player networking still require
manual testing on HTTPS-capable mobile devices as described in
[`AGENTS.md`](../AGENTS.md) and
[`games/tilt-rally/MULTIPLAYER_SETUP.md`](../games/tilt-rally/MULTIPLAYER_SETUP.md).
