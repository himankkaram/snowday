diff --git a/client/phone.html b/client/phone.html
index f5d5e44..942c884 100644
--- a/client/phone.html
+++ b/client/phone.html
@@ -27,6 +27,7 @@
         <p id="phase" class="muted">Waiting for the round to start</p>
         <label>Aim <input id="aim" type="range" min="-1" max="1" step="0.01" value="0" /></label>
         <button id="throw" class="throw-btn">Throw</button>
+        <div class="recharge" aria-hidden="true"><div id="recharge-fill"></div></div>
         <p id="feedback" class="feedback" role="status" aria-live="polite"></p>
         <div class="row">
           <button id="motion-btn">Use motion to throw</button>
diff --git a/client/src/host/main.ts b/client/src/host/main.ts
index 4fefeee..bfb6235 100644
--- a/client/src/host/main.ts
+++ b/client/src/host/main.ts
@@ -146,8 +146,18 @@ socket.on(EV.ACTION_RELAY, (a: ActionRelay) => {
   actionsThisSecond++;
   lastLatencyMs = Date.now() - a.serverTime;
   if (a.action !== 'throw') return;
-  // Launches a snowball (or ignores it during cooldown). The result comes later, in frame().
-  state = R.resolveThrow(state, a.aim, a.playerId, a.seq).state;
+  // Launches a snowball (or ignores it during cooldown). Hit/miss comes later, in frame().
+  const { state: next, outcome, cooldownMs } = R.resolveThrow(state, a.aim, a.playerId, a.seq);
+  state = next;
+  // Tell the phone so it can show its recharge bar. cooldownMs is 0 if the round isn't running.
+  if (outcome === 'thrown' || cooldownMs > 0) {
+    socket.emit(EV.HOST_EVENT, {
+      type: outcome === 'thrown' ? 'thrown' : 'cooldown',
+      playerId: a.playerId,
+      actionSeq: a.seq,
+      cooldownMs: Math.round(cooldownMs),
+    });
+  }
 });
 
 /** Called every frame for snowballs that just reached the rider: show it and tell the thrower. */
diff --git a/client/src/host/round.ts b/client/src/host/round.ts
index 070f063..1033518 100644
--- a/client/src/host/round.ts
+++ b/client/src/host/round.ts
@@ -122,12 +122,14 @@ export function resolveThrow(
   aim: number,
   playerId = 'anon',
   seq = 0,
-): { state: RoundState; outcome: ThrowOutcome } {
-  if (s.phase !== 'playing') return { state: s, outcome: 'ignored' };
+): { state: RoundState; outcome: ThrowOutcome; cooldownMs: number } {
+  // cooldownMs: after a throw, the full wait before the next one; if ignored, how long is left.
+  if (s.phase !== 'playing') return { state: s, outcome: 'ignored', cooldownMs: 0 };
   const now = ROUND_MS - s.timeLeftMs;
   const last = s.lastThrowAt[playerId];
-  if (last !== undefined && now - last < throwCooldownMs(s.players)) {
-    return { state: s, outcome: 'ignored' }; // still cooling down
+  const cooldown = throwCooldownMs(s.players);
+  if (last !== undefined && now - last < cooldown) {
+    return { state: s, outcome: 'ignored', cooldownMs: cooldown - (now - last) }; // still recharging
   }
   const ball: Snowball = { playerId, seq, x: clamp(aim), progress: 0 };
   return {
@@ -138,6 +140,7 @@ export function resolveThrow(
       snowballs: [...s.snowballs, ball],
     },
     outcome: 'thrown',
+    cooldownMs: cooldown,
   };
 }
 
diff --git a/client/src/phone/main.ts b/client/src/phone/main.ts
index cf3e56e..0affead 100644
--- a/client/src/phone/main.ts
+++ b/client/src/phone/main.ts
@@ -65,7 +65,11 @@ onEveryConnect(socket, () => {
 socket.on('disconnect', () => setNet('offline', 'bad'));
 socket.on(EV.ERROR, (e) => feedback(e.code === 'RATE_LIMITED' ? 'Slow down!' : e.message, 'err'));
 socket.on(EV.GAME_EVENT, (e) => {
-  if (e.type === 'hit') {
+  if (e.type === 'thrown') startRecharge(e.cooldownMs ?? 0);
+  else if (e.type === 'cooldown') {
+    startRecharge(e.cooldownMs ?? 0);
+    feedback('Recharging…');
+  } else if (e.type === 'hit') {
     feedback('Hit!', 'hit');
     navigator.vibrate?.(80); // Android only; iOS ignores it
   } else feedback('Missed', 'miss');
@@ -82,8 +86,26 @@ socket.on(EV.STATE, (s: HostState) => {
 // ---------- throwing ----------
 const aimSlider = $<HTMLInputElement>('aim');
 
+// Recharge bar. The host decides the cooldown and tells us how long it is; this just shows it
+// and stops us sending throws the host would ignore anyway.
+let readyAt = 0;
+function startRecharge(ms: number) {
+  readyAt = performance.now() + ms;
+  const fill = $('recharge-fill');
+  fill.style.transition = 'none';
+  fill.style.width = '0%';
+  void fill.offsetWidth; // make the browser apply 0% before animating to 100%
+  fill.style.transition = `width ${ms}ms linear`;
+  fill.style.width = '100%';
+  $('throw').classList.add('cooling');
+  setTimeout(() => {
+    if (performance.now() >= readyAt) $('throw').classList.remove('cooling');
+  }, ms);
+}
+
 function sendThrow(power: number, source: 'button' | 'motion') {
   if (!joined || !socket.connected) return feedback('Not connected', 'err');
+  if (performance.now() < readyAt) return feedback('Recharging…');
   // Strictly increasing even across page reloads, so the server never drops it as a replay.
   seq = Math.max(seq + 1, Date.now());
   socket.emit(EV.ACTION, { seq, action: 'throw', aim: Number(aimSlider.value), power, source });
diff --git a/client/src/styles.css b/client/src/styles.css
index 041a373..bc150f3 100644
--- a/client/src/styles.css
+++ b/client/src/styles.css
@@ -202,6 +202,22 @@ select {
 .throw-btn:active {
   transform: scale(0.98);
 }
+.throw-btn.cooling {
+  opacity: 0.5;
+}
+/* fills up while the player's throw recharges; full = ready */
+.recharge {
+  height: 0.9rem;
+  border: 3px solid var(--ink);
+  border-radius: 999px;
+  overflow: hidden;
+  background: var(--panel);
+}
+#recharge-fill {
+  height: 100%;
+  width: 100%;
+  background: var(--accent);
+}
 .feedback {
   min-height: 2.2em;
   font-size: 1.2rem;
diff --git a/shared/protocol.ts b/shared/protocol.ts
index 1698c71..4f84406 100644
--- a/shared/protocol.ts
+++ b/shared/protocol.ts
@@ -101,10 +101,13 @@ export type HostState = z.infer<typeof HostStateSchema>;
 
 /** Outcomes decided by the host and pushed back to individual players. */
 export const HostEventSchema = z.object({
-  type: z.enum(['hit', 'miss']),
+  /** hit/miss: a snowball landed. thrown: throw accepted. cooldown: throw ignored, still recharging. */
+  type: z.enum(['hit', 'miss', 'thrown', 'cooldown']),
   /** Which player's action caused it (player gets "You hit!" feedback). */
   playerId: z.string().max(64),
   actionSeq: z.number().int().nonnegative(),
+  /** thrown: the player's full cooldown. cooldown: how much of it is left. In ms. */
+  cooldownMs: z.number().int().min(0).max(60_000).optional(),
 });
 export type HostEvent = z.infer<typeof HostEventSchema>;
 
diff --git a/tests/protocol.test.ts b/tests/protocol.test.ts
index 9b9f429..3b0ff30 100644
--- a/tests/protocol.test.ts
+++ b/tests/protocol.test.ts
@@ -1,6 +1,7 @@
 import { describe, expect, it } from 'vitest';
 import {
   ActionSchema,
+  HostEventSchema,
   JoinSchema,
   makeRoomCode,
   parseBoardLine,
@@ -66,3 +67,21 @@ describe('makeRoomCode', () => {
     for (let i = 0; i < 200; i++) expect(makeRoomCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
   });
 });
+
+describe('HostEventSchema', () => {
+  const base = { playerId: 'abcdef12', actionSeq: 3 };
+  it('accepts recharge events with a cooldown', () => {
+    expect(HostEventSchema.safeParse({ ...base, type: 'thrown', cooldownMs: 2000 }).success).toBe(
+      true,
+    );
+    expect(HostEventSchema.safeParse({ ...base, type: 'cooldown', cooldownMs: 500 }).success).toBe(
+      true,
+    );
+  });
+  it('still accepts hit and miss without one', () =>
+    expect(HostEventSchema.safeParse({ ...base, type: 'hit' }).success).toBe(true));
+  it('rejects silly cooldowns', () =>
+    expect(HostEventSchema.safeParse({ ...base, type: 'thrown', cooldownMs: -1 }).success).toBe(
+      false,
+    ));
+});
diff --git a/tests/round.test.ts b/tests/round.test.ts
index 666e8cf..a9c6fd1 100644
--- a/tests/round.test.ts
+++ b/tests/round.test.ts
@@ -97,6 +97,16 @@ describe('throw cooldown', () => {
     const s = R.resolveThrow(R.start(R.newRound(), 2), 0, 'a').state;
     expect(R.resolveThrow(s, 0, 'b').outcome).not.toBe('ignored');
   });
+  it('tells the player how long their cooldown is, and how much is left', () => {
+    let s = R.start(R.newRound(), 1);
+    const first = R.resolveThrow(s, 0, 'a');
+    expect(first.cooldownMs).toBe(R.throwCooldownMs(1));
+    s = run(first.state, 500, 0);
+    const early = R.resolveThrow(s, 0, 'a');
+    expect(early.outcome).toBe('ignored');
+    expect(early.cooldownMs).toBeGreaterThan(0);
+    expect(early.cooldownMs).toBeLessThanOrEqual(R.throwCooldownMs(1) - 500);
+  });
   it('scales with players and caps out', () => {
     expect(R.throwCooldownMs(1)).toBe(R.BASE_COOLDOWN_MS);
     expect(R.throwCooldownMs(4)).toBe(2 * R.BASE_COOLDOWN_MS);
