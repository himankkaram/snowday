# Architecture and decisions

## The one rule

Phones send **intent** ("I threw, aiming at 0.3"). The **host screen** runs the simulation and decides
**outcomes** ("that was a hit"). The **server** checks who is allowed to say what and passes messages on.
That is how cheating is prevented: a phone has no message that means "I hit", and the server rejects
`host:event` from anyone who isn't the host (tested in `tests/server.test.ts`).

```
             ┌──────────────────────────── laptop ────────────────────────────┐
 phone ──┐   │  Node server (server/app.ts)          host page (Chrome)       │
 phone ──┼──▶│  - rooms, validation (zod)   ──────▶  - game loop @ 60 fps     │
 phone ──┘   │  - rate limits, /health      ◀──────  - rules (round.ts)       │
   ▲         │                                       - steering adapters ─────┼──USB──▶ ESP32 board
   └─────────┤  game:event / game:state                (keyboard always on)    │        (tilt in, buzz/LED out)
             └────────────────────────────────────────────────────────────────┘
```

## Stack and why

| Choice                    | Why                                                                                                            | Rejected                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| TypeScript                | Shared message types catch mismatches at build time, which is the #1 multiplayer bug                           | Plain JS: faster to start, but silent field-name drift                                            |
| Vite 7 (multi-page)       | Instant dev server, LAN exposure, proxy for sockets, simple build                                              | Webpack (slow config), Next.js (server rendering not needed)                                      |
| No UI framework           | Two small pages; the game is canvas. React adds build and state concepts for no gain here                      | React: fine later for menus, not needed now                                                       |
| Canvas 2D                 | Enough for a sled + snowballs; zero learning curve                                                             | Phaser: worth it if you want sprites/physics/tweens on the day; drop-in later on the host page    |
| Node 22 + Express 5       | Serves files and /health, one process                                                                          | Separate backend frameworks                                                                       |
| Socket.IO 4.8             | Rooms, acknowledgements, auto-reconnect, fallback to HTTP polling if a network blocks WebSockets               | Raw `ws`: lighter, but you'd hand-write rooms, acks, reconnect and heartbeats under time pressure |
| zod 3.25                  | One schema = runtime validation + TypeScript type                                                              | Hand-written `if` checks                                                                          |
| Vitest 3                  | Same config/TS as Vite, fast                                                                                   | Jest (extra TS setup)                                                                             |
| Web Serial (in host page) | Board talks straight to the page that runs the game: no extra hop, no native Node module to compile on Windows | Node `serialport` on the server: native build issues, extra hop for feedback                      |
| ESP32 Arduino core        | Most tutorials, Arduino IDE, USB serial built in                                                               | MicroPython (fine, but fewer team members will know it)                                           |

Dependency versions are pinned exactly in `package.json`, chosen from releases at least two weeks
old (a supply-chain precaution), on majors with well-known APIs.

## Board transport comparison

|                        | USB serial (chosen)                       | ESP32 over Wi-Fi                                                   | Phone as the board sensor                                  |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Reliability at a venue | Highest: no network involved              | Depends on venue Wi-Fi; ESP32 can't do eduroam-style logins easily | Depends on network + https                                 |
| Latency                | ~ms                                       | Variable                                                           | Variable                                                   |
| Feedback (buzz/LED)    | Yes, same cable                           | Yes                                                                | Phone vibration only (Android only; iOS web can't vibrate) |
| Setup                  | One cable; Chrome port picker once        | Credentials, IP discovery                                          | None                                                       |
| Downside               | Cable from board to laptop (tape it down) | Fragile                                                            | Not "hardware"                                             |

All three would fit behind `SteeringController`, so switching later doesn't touch game code.

## Protocol (source of truth: `shared/protocol.ts`)

| Event           | Direction                | Payload                                                | Rules                                                                                                            |
| --------------- | ------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `room:join`     | client→server (with ack) | `{v, room, role, name, clientId, hostKey?}`            | Host needs `HOST_KEY`. Players need an existing room. Same `clientId` = same player (reconnect). Max 32 players. |
| `player:action` | phone→server             | `{seq, action:'throw', aim -1..1, power 0..1, source}` | Players only. ≤8/s (token bucket). `seq` must increase; repeats dropped silently.                                |
| `host:action`   | server→host              | action + `{playerId, serverTime}`                      | Server stamps who sent it; phones can't spoof another player.                                                    |
| `host:state`    | host→server              | `{phase, timeLeftMs, riderId, score}`                  | Host only. Rebroadcast to room as `game:state`. Host sends 10/s.                                                 |
| `host:event`    | host→server              | `{type:'hit'                                           | 'miss', playerId, actionSeq}`                                                                                    | Host only. Delivered to that one player as `game:event`. |
| `room:roster`   | server→all in room       | `{room, hostConnected, players[]}`                     | Sent on any join/leave/disconnect.                                                                               |
| `app:error`     | server→sender            | `{code, message}`                                      | Sent for every rejected message.                                                                                 |

Example payloads:

```json
{"v":1,"room":"K7QX","role":"player","name":"Zain","clientId":"6f1c2a0e-…"}
{"seq":1761245000123,"action":"throw","aim":-0.31,"power":0.7,"source":"motion"}
{"type":"hit","playerId":"b0c1…","actionSeq":1761245000123}
```

Invalid messages never throw: `safeParse` → `app:error {code:'BAD_MESSAGE'}` → counted in `/health`.

USB line protocol (115200 baud): board sends `S,<steer>` ~50/s and `I,<text>`; host sends `H`, `L,<effect>`, `C`.

## Phone sensors: the facts that matter

- `devicemotion` / `deviceorientation` are restricted to secure contexts (https or localhost) by the spec.
- iOS Safari requires `DeviceMotionEvent.requestPermission()` (and the orientation equivalent),
  called from a tap; it rejects if there's no user activation. Android Chrome has no prompt.
  Source: MDN, DeviceMotionEvent.requestPermission() and DeviceOrientationEvent.requestPermission().
- iOS web pages can't vibrate (`navigator.vibrate` is unsupported), so phone-side "hit" feedback is visual.
- Throw detection: magnitude of linear acceleration crosses ~18 m/s² → fire once → re-arm only after
  600 ms **and** the signal drops below half the threshold. Aim: phone's left/right tilt (`gamma`)
  relative to a "Calibrate" snapshot. The button is always shown and always works.
- Phones send **one message per throw**, never a raw sensor stream.

## What the server does NOT do

No database, no accounts, no game rules, no physics. If the server restarts, phones and host reconnect
and re-join automatically; the round restarts from the host.
