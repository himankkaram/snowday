/**
 * Early-2000s HUD for the host canvas: WordArt timer, chrome score pill, XP health bar,
 * lobby and win/lose screens. The 3D slope itself is drawn by scene.ts.
 */
import { MAX_HEALTH, type RoundState } from './round';

export const FONT_DISPLAY = '"Arial Black", Impact, "Trebuchet MS", sans-serif';
export const FONT_UI = '"Trebuchet MS", Tahoma, Verdana, sans-serif';

const reducedMotion =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** WordArt-style text: gradient fill, thick outline, drop shadow. */
function wordArt(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  stops: string[],
  outline = '#082a73',
) {
  ctx.font = `italic ${size}px ${FONT_DISPLAY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const g = ctx.createLinearGradient(0, y - size, 0, y);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  ctx.lineJoin = 'round';
  ctx.fillStyle = 'rgba(8,30,90,0.45)';
  ctx.fillText(text, x + size * 0.06, y + size * 0.07);
  ctx.lineWidth = Math.max(4, size * 0.12);
  ctx.strokeStyle = outline;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = g;
  ctx.fillText(text, x, y);
}

const CHROME = ['#ffffff', '#c6f0ff', '#39a8ff', '#0b4fd6', '#7fd2ff'];

export function drawHud(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  state: RoundState,
  now: number,
) {
  // timer
  const secs = Math.ceil(state.timeLeftMs / 1000);
  const urgent = state.phase === 'playing' && secs <= 10;
  wordArt(
    ctx,
    String(secs),
    w / 2,
    90,
    76,
    urgent ? ['#ffffff', '#ffe600', '#ff8a00', '#ff2f2f', '#ffb3b3'] : CHROME,
  );

  // score pill (glossy aqua)
  const label = `Hits ${state.hits} / Throws ${state.throws}`;
  ctx.font = `bold 22px ${FONT_UI}`;
  const tw = ctx.measureText(label).width;
  const pw = tw + 48;
  const px = w / 2 - pw / 2;
  const py = 108;
  const pill = ctx.createLinearGradient(0, py, 0, py + 36);
  pill.addColorStop(0, '#c9efff');
  pill.addColorStop(0.48, '#48b4ff');
  pill.addColorStop(0.52, '#0a6fe0');
  pill.addColorStop(1, '#5cc6ff');
  ctx.fillStyle = pill;
  ctx.strokeStyle = '#0b4fae';
  ctx.lineWidth = 2;
  roundRect(ctx, px, py, pw, 36, 18);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  roundRect(ctx, px + 10, py + 3, pw - 20, 12, 6);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,40,110,0.8)';
  ctx.shadowOffsetY = 1;
  ctx.fillText(label, w / 2, py + 26);
  ctx.shadowColor = 'transparent';
  ctx.shadowOffsetY = 0;

  drawHealthBar(ctx, w / 2, py + 52, Math.min(440, w * 0.42), state.health, now);

  // corner logo
  ctx.save();
  ctx.textAlign = 'left';
  wordArtLeft(ctx, '❄ SNOW DAY', 18, 52, 34);
  ctx.restore();

  // lobby / round over
  if (state.phase !== 'playing') {
    const bob = reducedMotion ? 0 : Math.sin(now / 300) * 6;
    const rainbow = ['#ff2fa0', '#ff8a00', '#ffe600', '#4cff4c', '#00c8ff'];
    if (state.phase === 'lobby') {
      wordArt(
        ctx,
        'Press SPACE to start!',
        w / 2,
        h * 0.45 + bob,
        Math.min(64, w / 14),
        rainbow,
        '#3a0a6b',
      );
      const blink = reducedMotion || Math.floor(now / 600) % 2 === 0;
      if (blink) {
        ctx.font = `bold 24px ${FONT_UI}`;
        ctx.fillStyle = '#0b2a6b';
        ctx.textAlign = 'center';
        ctx.fillText('★ scan the QR code to join the snowball fight ★', w / 2, h * 0.45 + 50);
      }
      subtitle(
        ctx,
        `Rider: survive ${Math.round(state.timeLeftMs / 1000)} s and dodge by leaning · each hit = -10 health`,
        w / 2,
        h * 0.45 + 88,
      );
    } else if (state.result === 'lose') {
      const fire = ['#ffffff', '#ffe600', '#ff8a00', '#ff2f2f', '#9b0d10'];
      wordArt(ctx, 'WIPEOUT!', w / 2, h * 0.4 + bob, Math.min(96, w / 8), fire, '#3a0000');
      wordArt(ctx, 'Snowballers win!', w / 2, h * 0.4 + 70, Math.min(44, w / 20), CHROME);
      subtitle(
        ctx,
        `The rider took ${state.hits} hits · Press SPACE to play again`,
        w / 2,
        h * 0.4 + 112,
      );
    } else {
      wordArt(ctx, 'YOU SURVIVED!', w / 2, h * 0.4 + bob, Math.min(88, w / 10), rainbow, '#3a0a6b');
      wordArt(ctx, 'Rider wins!', w / 2, h * 0.4 + 70, Math.min(44, w / 20), CHROME);
      subtitle(
        ctx,
        `${state.health} health left after ${state.hits} hits · Press SPACE to play again`,
        w / 2,
        h * 0.4 + 112,
      );
    }
  }
  ctx.textAlign = 'start';
}

function wordArtLeft(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
) {
  ctx.font = `italic ${size}px ${FONT_DISPLAY}`;
  const width = ctx.measureText(text).width;
  wordArt(ctx, text, x + width / 2, y, size, CHROME);
}

function subtitle(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.font = `bold 20px ${FONT_UI}`;
  ctx.textAlign = 'center';
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#0b2a6b';
  ctx.fillText(text, x, y);
}

/** Windows XP-style progress bar: glossy blocks in a beveled frame. */
function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  width: number,
  health: number,
  now: number,
) {
  const height = 30;
  const x = cx - width / 2;
  const frac = Math.max(0, Math.min(1, health / MAX_HEALTH));
  const low = frac <= 0.3;
  const blinkOff = low && !reducedMotion && Math.floor(now / 250) % 2 === 0;

  // label
  ctx.font = `bold 15px ${FONT_UI}`;
  ctx.textAlign = 'left';
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.strokeText('RIDER HEALTH', x, y - 6);
  ctx.fillStyle = '#0b2a6b';
  ctx.fillText('RIDER HEALTH', x, y - 6);
  ctx.textAlign = 'right';
  const val = `${health} / ${MAX_HEALTH}`;
  ctx.strokeText(val, x + width, y - 6);
  ctx.fillStyle = low ? '#c3171b' : '#0b2a6b';
  ctx.fillText(val, x + width, y - 6);

  // frame
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#686868';
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, width, height, 4);
  ctx.fill();
  ctx.stroke();

  // blocks (10 health each)
  const blocks = MAX_HEALTH / 10;
  const pad = 4;
  const gap = 3;
  const bw = (width - pad * 2 - gap * (blocks - 1)) / blocks;
  const filled = Math.ceil(frac * blocks - 1e-9);
  const [top, mid, bottom] =
    frac > 0.5
      ? ['#b6f7a0', '#37c22a', '#1f8a14']
      : frac > 0.3
        ? ['#fff3a0', '#ffc400', '#c98a00']
        : ['#ffb3a8', '#ff3b2f', '#a8100a'];
  for (let i = 0; i < blocks; i++) {
    const bx = x + pad + i * (bw + gap);
    if (i >= filled || blinkOff) {
      ctx.fillStyle = '#e6ecf3';
      ctx.fillRect(bx, y + pad, bw, height - pad * 2);
      continue;
    }
    const g = ctx.createLinearGradient(0, y + pad, 0, y + height - pad);
    g.addColorStop(0, top);
    g.addColorStop(0.5, mid);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(bx, y + pad, bw, height - pad * 2);
  }
  ctx.textAlign = 'start';
}
