# Snow Day — real-time party game boilerplate

A host screen (laptop + big display) runs the game. Phones join by QR code and send actions.
A USB microcontroller board steers and gives physical feedback. Keyboard always works as a fallback.

```
 phones (browser) ──Socket.IO──▶ Node server ──▶ host screen (browser, runs the rules)
                  ◀── feedback ──             ◀──  outcomes
                                               host ──Web Serial (USB)──▶ ESP32 board
```

What is verified vs not is listed at the bottom. Read that before relying on anything.

## Setup (all platforms)

1. Install **Node 22 LTS** (22.12 or newer). Check: `node -v`.
   - macOS/Linux with nvm: `nvm install 22 && nvm use`
   - Windows: install from nodejs.org, or `winget install OpenJS.NodeJS.LTS`
2. Install **Google Chrome** on the host laptop (Web Serial needs Chrome or Edge on desktop).
3. Clone and install:
   ```bash
   git clone <your-repo-url> snowday && cd snowday
   npm install
   cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
   ```
4. Edit `.env`: set `HOST_KEY` to something only your team knows.
5. Check your machine: `npm run doctor`, then `npm run check` (typecheck + tests + build).
   Every line should say PASS and all tests should pass.

## Run

```bash
npm run dev
```

- Host screen (on the laptop, keep it on localhost so USB works): `http://localhost:5173/host.html?key=YOUR_HOST_KEY`
- Phones: scan the QR on the host screen.
- Health: `http://localhost:5173/health`

Keys on the host: **Space** start round · **R** reset · **D** debug overlay · **C** recalibrate board · **← →** steer.

### Getting phones connected (read this)

Phones cannot open `localhost`. The host page shows the laptop's LAN address in the QR, which works
**only if phones and laptop are on the same network and the network lets devices talk to each other**
(many university networks, including eduroam, block this).

Motion sensors on phones only work over **https**. Plain `http://192.168…` gives button-only play.

| Situation                                       | Do this                                                                                                                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Venue has internet (recommended)                | Run a tunnel: `cloudflared tunnel --url http://localhost:5173`. Put the printed `https://….trycloudflare.com` URL in `.env` as `VITE_PUBLIC_URL`, restart `npm run dev`. Phones get real https, so motion works. |
| Venue Wi-Fi isolates devices but internet works | Same as above. The tunnel goes around the isolation.                                                                                                                                                             |
| No internet at all                              | Laptop and phones join one phone's hotspot. Phones use the LAN QR. Buttons work; motion needs `DEV_HTTPS=true` (self-signed cert, accept the warning; **untested** whether iOS then allows motion).              |

Install cloudflared: macOS `brew install cloudflared` · Windows `winget install --id Cloudflare.cloudflared` ·
Linux: the `.deb`/binary from github.com/cloudflare/cloudflared/releases. No account needed for quick tunnels.
The quick-tunnel URL changes every time you start it.

### Production mode (for the demo)

```bash
npm run serve      # builds, then serves everything from the Node server on PORT (3000)
cloudflared tunnel --url http://localhost:3000
```

`VITE_PUBLIC_URL` is baked in at build time, so set it before `npm run serve`. If the host process
crashes, rerun `npm start`: phones reconnect by themselves and keep their identity.

## Scripts

| Command                                            | What it does                                               |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `npm run dev`                                      | Server (auto-restart) + Vite dev server with hot reload    |
| `npm test`                                         | All unit + integration tests                               |
| `npm run typecheck`                                | TypeScript, no output files                                |
| `npm run lint`                                     | Typecheck + Prettier check                                 |
| `npm run format`                                   | Auto-format everything                                     |
| `npm run build`                                    | Build client to `dist/client`                              |
| `npm run serve`                                    | Build + run production server                              |
| `npm run load-test -- http://localhost:3000 30 10` | 30 fake phones for 10 s against a running server           |
| `npm run doctor`                                   | Checks Node version, deps, `.env`, network                 |
| `npm run check`                                    | doctor + typecheck + tests + build: run before every merge |

## Layout

```
shared/protocol.ts       Every message, schema, limit and the USB line protocol. Change messages HERE only.
server/app.ts            Express + Socket.IO relay: rooms, validation, rate limits, /health, /info
server/rooms.ts          Room/player bookkeeping (no networking; unit-tested)
server/rateLimit.ts      Token bucket
client/host.html         Host screen  -> client/src/host/main.ts (loop, render, debug overlay)
client/src/host/round.ts Game rules: phases, timer, rider, placeholder hit rule (pure, tested)
client/phone.html        Phone page   -> client/src/phone/main.ts
client/src/phone/motion.ts  Motion permission + throw detector (pure parts tested)
client/src/input/        SteeringController interface + keyboard, mock, Web Serial adapters
firmware/board_controller/  ESP32 + MPU-6050 sketch
tests/                   Vitest tests
scripts/                 load-test, doctor
docs/                    ARCHITECTURE, HARDWARE, PLAN
```

## Git rules for the weekend

- `main` must always run. Before merging: `npm run check`.
- Short branches: `feat/board-steering`, `fix/phone-rejoin`. Merge at least every 2–3 hours.
- Only one person edits `shared/protocol.ts` at a time; announce it in the team chat first.
- Commit messages say what changed: `phone: add throw cooldown`, not `stuff`.
- Feature freeze at hour 20: after that, `fix/` branches only.

## Verified vs not (as of this commit)

**Verified in a headless test environment:** typecheck, 47 automated tests (protocol validation,
rate limiting, round logic, steering helpers, throw detector on synthetic data, mock controller,
server join/relay/abuse/reconnect), production build, a 30-client load test on loopback
(0 lost messages), dev-mode proxy, and a headless Chrome run of host + emulated iPhone page:
join, throw, hit/miss feedback, keyboard steering, mock board, page reload rejoins as same player.

**Not verified yet (do these tonight):** real phones on a real network; iOS/Android motion permission
and throw thresholds; Web Serial with a real ESP32; the firmware (syntax-checked against stub headers only,
never compiled for ESP32 or run); the tunnel; the self-signed HTTPS path.
