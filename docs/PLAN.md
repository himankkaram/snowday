# Plan: tonight, the event, the demo

## Before you go (tonight)

HackNotts 26 is on 24 October 2026, so "pre-hackathon" means this evening. In priority order;
stop wherever you run out of time.

| #   | Task                                                                                                    | Essential?    | Done when                                                                               |
| --- | ------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| 1   | Ask an organiser whether pre-written code is allowed and how to declare it                              | **Essential** | You have an answer. If "no", use this repo only as reference and retype it at the event |
| 2   | Every teammate: clone, `npm install`, `.env`, `npm run check`                                           | **Essential** | All PASS, 47 tests pass                                                                 |
| 3   | `npm run dev`, open host on laptop, join from **2 real phones** (one iPhone, one Android) on home Wi-Fi | **Essential** | Both on the roster, throws show hit/miss                                                |
| 4   | Install cloudflared, run the tunnel, set `VITE_PUBLIC_URL`, test **motion throw** on both phones        | **Essential** | Flick throws on both; note the peak values shown on the phone                           |
| 5   | Install Arduino IDE + ESP32 core + USB driver on the hardware person's laptop                           | **Essential** | Boards Manager shows esp32 installed                                                    |
| 6   | If you own an ESP32 + MPU-6050: validation steps 1–7 in HARDWARE.md                                     | Nice to have  | Debug overlay shows ~50 lines/s                                                         |
| 7   | `npm run load-test -- http://localhost:3000 30 10` while `npm run serve` is running                     | Nice to have  | 0 lost                                                                                  |
| 8   | Sleep                                                                                                   | **Essential** | 7+ hours                                                                                |

## During the event (24 h, assuming a midday start)

| Hours | Team-wide goal                                                            | Freeze rule                                                                      |
| ----- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 0–1   | Retype/clone foundation, tunnel up, phones joining at the venue           | Don't touch art                                                                  |
| 1–4   | Hardware: board streaming into host. Game: real snowballs (see below)     |                                                                                  |
| 4–8   | Board on the plank + calibrated; hit feedback buzzes; motion throws tuned |                                                                                  |
| 8–12  | **Integration checkpoint:** full round with rider on board + 3 phones     | If the board isn't working by hour 12, cut LEDs; by 16, demo with keyboard rider |
| 12–16 | Early-2000s visual identity, sound, lobby/QR polish                       |                                                                                  |
| 16–20 | Sleep in shifts; bug fixes; one stretch feature max                       | **Hour 20: feature freeze**                                                      |
| 20–22 | Playtest with strangers; record a backup video of a full round            | Fixes only                                                                       |
| 22–24 | Submission write-up, rehearse demo 3×, charge everything                  | Nothing new                                                                      |

48 hours: keep the same order. Use the extra day for art, sound, a rider-rotation lobby and playtesting,
not a bigger concept. Freeze at hour 40.

## Building the real game on the boilerplate (event work)

Everything lives in `client/src/host/round.ts` (rules) and `client/src/host/main.ts` (drawing):

1. Add `snowballs: {id, x, y, vx, vy, playerId, seq}[]` to `RoundState`.
2. `resolveThrow` spawns a snowball at the bottom of the screen aimed at `aim` (instead of the instant check);
   returns `'ignored'` only outside a round.
3. In `step`, move snowballs; when one reaches the rider's row, check overlap with `riderX ± RIDER_HALF_WIDTH`,
   record hit/miss, and **return the outcomes** so `main.ts` emits `host:event` and calls `sendHitFeedback()`.
4. Write a test per rule before drawing anything (copy the style of `tests/round.test.ts`).
   Keep the server untouched: if you're editing `server/` during the event, ask why.

## Team (4 people; with 2–3, merge roles 1+4 and 2+3)

| Role                  | Owns                                   | First deliverable                          | Acceptance                                               |
| --------------------- | -------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| 1. Game               | `round.ts`, host drawing               | Snowballs fly and hit                      | Tests pass; round playable with keyboard + phone buttons |
| 2. Hardware           | firmware, wiring, platform             | Board steering in the debug overlay        | Steps 1–10 of HARDWARE.md                                |
| 3. Phone + network    | phone page, motion, tunnel             | Motion throw on iOS + Android at the venue | 10 flicks → 10 throws, 0 accidental                      |
| 4. Look, sound, pitch | CSS/art/audio, demo script, submission | Y2K identity on host + phone               | A stranger understands the screen in 10 s                |

Agree before splitting up: the protocol stays as is; any change goes through one person and `npm run check`.
Integration checklist every 3 hours: pull `main`, `npm run check`, run one full round with every input.

## Risk register

| Risk                         | Prob. | Impact | Mitigation                                                 | Fallback                                      |
| ---------------------------- | ----- | ------ | ---------------------------------------------------------- | --------------------------------------------- |
| Venue Wi-Fi isolates devices | High  | High   | Tunnel from the start                                      | Phone hotspot for everyone                    |
| No internet at all           | Low   | High   | Test hotspot mode tonight                                  | Buttons only over LAN http                    |
| iOS motion permission fails  | Med   | Med    | Permission button + clear message; test tonight            | Throw button (always visible)                 |
| Throw gesture misfires       | Med   | Med    | Threshold + cooldown + re-arm; tune with on-screen peak    | Button                                        |
| Board not detected           | Med   | High   | Data cable, driver installed tonight, close Serial Monitor | Keyboard rider (always on)                    |
| Sensor noise/jitter          | Med   | Med    | Firmware low-pass + deadzone + host smoothing              | Raise deadzone / lower `FILTER_ALPHA`         |
| Motor resets ESP32           | Low   | Med    | Driver module or transistor + diode                        | Unplug motor; LED-only feedback               |
| Cable yanked mid-demo        | Med   | Med    | Tape cable flat; steer drops to 0 on unplug                | Replug, keyboard meanwhile                    |
| Server/host crash            | Low   | High   | Errors logged not fatal; phones auto-rejoin                | `npm start` again (≈3 s)                      |
| Too many phones              | Low   | Low    | Rate limits; load-tested 30                                | Cap is 32 per room                            |
| Collision bugs               | Med   | Med    | Pure rules + tests                                         | Placeholder instant rule still works          |
| Art eats the schedule        | High  | Med    | Art only from hour 12                                      | Placeholder look is clean, not broken         |
| Last-minute breakage         | Med   | High   | Freeze at 20, `check` before merging                       | Backup video + last good commit tagged `demo` |

## Demo (≈2 min per judge)

Set up: big monitor showing the host page in full screen (F11), QR large, debug overlay off, board on the
mat, spare charged phones on the table.

1. **(10 s)** "In 2006 the Wii got everyone off the sofa. This is that, for a whole room."
2. **(15 s)** Hand the judge a phone: "Scan this, you're throwing snowballs." Invite another judge onto the board.
3. **(60 s)** Play a round. Let them feel a hit buzz under their feet.
4. **(20 s)** The engineering: one message format for every device; phones send intent, the host decides
   outcomes so nobody can cheat; USB for the board so venue Wi-Fi can't break it; unplug the board live and show
   it keeps running.
5. **(10 s)** "Want another go?"

If something breaks: keyboard rider + button throws, keep talking, show the backup video only if nothing runs.
