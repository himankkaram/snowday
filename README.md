# ❄ Snow Day

**One person rides a real board. Everyone else throws snowballs at them from their phones.**

Snow Day is a party game made for HackNotts 26 (theme: the early 2000s). The rider stands on a
balance board and leans to dodge down a ski slope on the big screen. Everyone else scans a QR code
and flicks their phone to throw snowballs at them. No app, no install, and the whole thing looks like
it was made on a Windows XP machine in 2003.

## How to play

- **The rider** stands on the board and leans left or right to steer. They start with **100 health**,
  and every snowball that hits takes **10**. Survive the full **60 seconds** and the rider wins. Hit 0
  and the throwers win.
- **The throwers** scan the QR code on the host screen, tilt their phone to aim, and **flick** it to
  throw (or tap the big **THROW!** button). A harder flick throws a faster snowball.
- Snowballs take a moment to fly, so a rider who sees one coming can lean out of the way. A hit only
  counts if the rider is still there when it lands.
- After each throw, a **recharge bar** fills up on the phone before you can throw again. The more
  people playing, the longer each person waits, so a big crowd can't just bury the rider.

## How it works

```
 phones (browser) ──Socket.IO──▶ Node server ──▶ host screen (browser, runs the game)
                  ◀── hit/miss, recharge ──     ◀── results
                                                host ◀──USB (Web Serial)── ESP32 + accelerometer on the board
```

- **Host screen** (`client/src/host/`): runs the game rules and draws everything. A pseudo-3D downhill
  slope like an old arcade racer, plus a Y2K HUD with a WordArt timer, a chrome score pill and an XP-style
  health bar.
- **Phones** (`client/src/phone/`): a web page, joined by QR code. Motion controls use the phone's
  sensors. The aim is taken from where the phone was pointing a quarter of a second _before_ the flick,
  because the flick itself swings the phone and would ruin the aim.
- **Server** (`server/`): a small Node + Socket.IO relay. It handles rooms, checks every message against
  a schema, and rate-limits spam. The host decides all the outcomes.
- **The board** (`firmware/board_controller/`): an ESP32 with an ADXL345 accelerometer, mounted on a
  board rocking on a rolled-up mat. It works out the tilt from gravity, smooths it, and sends a steering
  value over USB 50 times a second. It also works with an MPU-6050 and detects which sensor is plugged in.
- **Game rules** (`client/src/host/round.ts`): pure functions with no screen or network code, so every
  rule is covered by tests.

**Tech:** TypeScript, Vite, Node, Express, Socket.IO, Zod, Vitest, Canvas 2D, Web Serial, Arduino (ESP32).

## Run it

You need Node 22.12+ and Chrome or Edge on the host laptop (Web Serial needs a desktop Chromium browser).

```bash
npm install
cp .env.example .env      # then set HOST_KEY to something only your team knows
npm run dev
```

1. **Host screen:** open `http://localhost:5173/host.html?key=YOUR_HOST_KEY` on the laptop.
2. **Board:** plug the ESP32 in by USB **with the board sitting level**, since it calibrates on power-up.
   Connect it from the host screen, then have the rider stand still in the middle and press **C**.
3. **Phones:** scan the QR code. Motion controls need **https**, and many uni networks block phones from
   reaching a laptop directly, so run a tunnel and put its address in `.env` as `VITE_PUBLIC_URL`:
   - ngrok: `ngrok http 5173` (or with your fixed `--url`). We used this, because the uni Wi-Fi blocked cloudflared.
   - cloudflared: `cloudflared tunnel --url http://localhost:5173`

   Then restart `npm run dev`. On ngrok's free plan, phones see a warning page once; tap **Visit Site**.

**Host keys:** **Space** start round · **R** reset · **C** recalibrate board · **D** debug overlay ·
**← →** steer (keyboard fallback if the board isn't plugged in).

**On the phone:** tap **Use motion to throw**, hold the phone tilted back a little (like you're reading
it), point at the middle of the screen and tap **Calibrate aim**. The **THROW!** button always works too.

## Project layout

```
client/src/host/round.ts     Game rules: rider, snowballs, health, win/lose, throw cooldown (tested)
client/src/host/main.ts      Host loop: input, sending results to phones, drawing
client/src/host/scene.ts     The pseudo-3D ski slope
client/src/host/theme.ts     Y2K HUD: timer, score, health bar, lobby and win/lose screens
client/src/phone/main.ts     Phone page: join, aim, throw, recharge bar
client/src/phone/motion.ts   Motion permission, flick detector, aim history
client/src/input/            Steering sources: USB board (Web Serial), keyboard, mock
shared/protocol.ts           Every message between phones, server, host and board
server/                      Socket.IO relay, rooms, validation, rate limits
firmware/board_controller/   ESP32 + ADXL345/MPU-6050 tilt controller
firmware/board_mega_knob/    Backup controller: Arduino Mega + a knob
tests/                       65 automated tests (Vitest)
docs/                        Architecture, hardware and planning notes
```

```bash
npm test           # all tests
npm run typecheck  # TypeScript
npm run check      # environment check + typecheck + tests + build
```

## How we built it

- **Friday evening, the starting boilerplate:** realtime rooms, the phone and host pages, steering
  adapters, a first firmware sketch, docs and tests.
- **Saturday, the hardware:** the MPU-6050 was swapped for an ESP32 + ADXL345 from the hardware desk.
  The firmware now supports both, and the sensor can be mounted under the deck. Uni Wi-Fi blocked
  cloudflared, so we moved to ngrok. We built the rocking board rig (a rolled-up mat,
  taped down) and got tilt steering working end to end.
- **Saturday night, the game:** real flying snowballs replaced the instant-hit placeholder, plus health,
  win/lose, the pseudo-3D slope and the early-2000s look. We added a per-player throw cooldown that
  scales with the number of players (2 s × √players, capped at 6 s), and a recharge bar on phones so
  players can see it. The unused LED and buzzer code came out of the firmware, and its comments were
  rewritten so a newcomer can follow them.
- **Sunday morning, playtesting:** motion aim felt random, because the phone read its tilt mid-flick.
  It now aims from just before the flick, with smoothing and better holding instructions.

## Known limits

- **Phone vibration** only works on Android. iPhones don't let websites vibrate, so there's on-screen
  feedback for everyone.
- **The board has no buzzer or LED** on this build. The rider sees hits on the big screen instead.
- **Motion controls need https,** so use a tunnel. The **THROW!** button works without one.

## Team

Zain Kashif and Himank Karam, HackNotts 26.
