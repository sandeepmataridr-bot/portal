import { useEffect, useRef } from 'react';
import { Leaf as LeafIcon, LogIn } from 'lucide-react';
import { CROWN_EDGE, CROWN_FRONT, CROWN_RECT, LEAF_CELL, LEAF_KINDS, LEAF_PAD, SCENE_SIZE, SUN, TREE_LEAF_LEN } from './sceneData';
import './wind-landing.css';

/**
 * Public landing page at the site root (https://0dh.in/): one calm screen.
 * The scene is the owner's painting of a tree on a sunrise hill, with the
 * leaves painted in its sky removed. Real, photographed leaves, sized and
 * coloured like the painted tree's own, break off the tree: mostly from the
 * front of the crown, some from behind it through the foliage. Each one
 * trembles on its twig, lets go in a gust, flutters or tumbles down on the
 * wind and settles in the grass. The hospital app itself lives behind /login
 * and /app (at https://app.0dh.in when hosted; this page is then built on its
 * own for Cloudflare Pages, see vite.landing.config.ts). Styles are scoped
 * under .wind-landing so nothing leaks into the rest of the app.
 */

/** The staff app's login. A plain link, so it also works from the stand-alone
    home page build (src/landing-main.tsx), where the app lives at VITE_APP_URL. */
const SIGN_IN_URL = `${import.meta.env.VITE_APP_URL ?? ''}/login`;
const BG = '/landing/scene-bg.webp';
const CROWN = '/landing/scene-crown.webp';
const LEAVES = '/landing/scene-real-leaves.webp';
const { w: SW, h: SH } = SCENE_SIZE;
/** Leaves available to the tree; how many are in the air at once follows the wind. */
const POOL = 90;
/** Atlas columns. */
const SHADE = 0;
const MID = 1;
const LIT = 2;
const BACK = 3;
/** Where the near meadow meets a leaf's path (painting px): it settles there or a little nearer. */
const groundAt = (x: number) => 705 + 0.055 * x;

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Gust strength 0..1 at painting x; gust fronts sweep from the tree to the right. */
const gustAt = (t: number, x: number) => {
  const u = t - x / 340;
  return clamp(0.5 + 0.24 * Math.sin(u * 0.37) + 0.16 * Math.sin(u * 0.91 + 1.3) + 0.1 * Math.sin(u * 2.1 + 0.6), 0, 1);
};

/** Smooth 3D value noise in -1..1. */
const hash3 = (x: number, y: number, z: number) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function noise3(x: number, y: number, z: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const s = (v: number) => v * v * (3 - 2 * v);
  const u = s(x - xi);
  const v = s(y - yi);
  const w = s(z - zi);
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  const n = lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
  return n * 2 - 1;
}

/** Eddy sizes (painting px), how fast they evolve, and their speed (px/s). */
const EDDIES = [
  { size: 300, evolve: 0.05, speed: 45, seed: 0 },
  { size: 110, evolve: 0.12, speed: 20, seed: 17.3 },
];

/**
 * Swirling air (painting px/s): the curl of a noise field, so it loops and
 * eddies without ever piling up or draining, like real turbulence.
 */
function eddies(x: number, y: number, t: number): [number, number] {
  const e = 0.01;
  let vx = 0;
  let vy = 0;
  for (const o of EDDIES) {
    const X = x / o.size;
    const Y = y / o.size;
    const T = t * o.evolve + o.seed;
    vx += (o.speed * (noise3(X, Y + e, T) - noise3(X, Y - e, T))) / (2 * e);
    vy -= (o.speed * (noise3(X + e, Y, T) - noise3(X - e, Y, T))) / (2 * e);
  }
  return [vx, vy];
}

/** A leaf's life: waiting on the tree, trembling before it lets go, falling, lying in the grass. */
const WAIT = 0;
const HANG = 1;
const FALL = 2;
const REST = 3;

/** How it falls: rocks and swings like a pendulum, rolls over about its midrib, or turns end over end. */
const FLUTTER = 0;
const ROLL = 1;
const TUMBLE = 2;

interface Leaf {
  state: number;
  t: number; // seconds in the current state
  front: boolean; // breaks off the front of the crown (else slips out from behind it)
  kind: number; // atlas row
  len: number; // tip-to-stem length, painting px
  depth: number; // > 1 for leaves falling nearer the viewer: bigger and faster across the view
  sun: number; // how sunlit its spot on the tree was: 0 deep shade .. 1 full sun
  x: number;
  y: number;
  vx: number;
  vy: number;
  drag: number; // 1/s: how quickly it follows the moving air
  sink: number; // fall speed in still air, px/s
  mode: number; // FLUTTER | ROLL | TUMBLE
  psi: number; // turn in the picture plane
  spin: number;
  rock: number; // rocking about its width, rad
  lean: number; // lean about its midrib, rad
  phase: number;
  rate: number; // rad/s
  swing: number; // sideways pendulum swing, px
  hangFor: number;
  landAt: number; // y where it reaches the grass along its path, past the meadow line
}

/** Somewhere on the crown's front, favouring the sunlit foliage that faces the viewer. */
function pickFront() {
  let p: readonly number[];
  do p = CROWN_FRONT[Math.floor(Math.random() * CROWN_FRONT.length)];
  while (Math.random() > 0.35 + 0.65 * clamp((p[2] - 60) / 90, 0, 1));
  return p;
}

/** Sets a waiting leaf on the tree, about to let go. */
function attach(leaf: Leaf) {
  leaf.front = Math.random() < 0.65;
  if (leaf.front) {
    const [x, y, tone] = pickFront();
    leaf.x = x;
    leaf.y = y;
    leaf.sun = clamp((tone - 60) / 90, 0, 1);
  } else {
    // from the far side, slipping out past the sunlit downwind edge
    let e: readonly number[];
    do e = CROWN_EDGE[Math.floor(Math.random() * CROWN_EDGE.length)];
    while (Math.random() > (e[0] - 560) / 380);
    leaf.x = e[0] - rand(10, 30);
    leaf.y = e[1] + rand(-8, 8);
    leaf.sun = 0.5;
  }
  const near = leaf.front && Math.random() < 0.1;
  leaf.depth = near ? rand(1.4, 1.8) : rand(0.85, 1.25);
  leaf.len = TREE_LEAF_LEN * leaf.depth;
  leaf.landAt = near ? rand(60, 120) : rand(0, 70);
  leaf.kind = Math.floor(Math.random() * LEAF_KINDS);
  leaf.vx = 0;
  leaf.vy = 0;
  leaf.drag = rand(1, 2.2);
  leaf.sink = rand(38, 70);
  const m = Math.random();
  leaf.mode = m < 0.6 ? FLUTTER : m < 0.8 ? ROLL : TUMBLE;
  leaf.psi = rand(-Math.PI, Math.PI);
  leaf.spin = rand(-0.8, 0.8);
  leaf.rock = rand(0.5, 1);
  leaf.lean = rand(-0.6, 0.6);
  leaf.phase = rand(0, Math.PI * 2);
  leaf.rate = leaf.mode === FLUTTER ? rand(2.2, 3.6) : rand(3, 6) * (Math.random() < 0.5 ? -1 : 1);
  leaf.swing = (leaf.mode === FLUTTER ? rand(0.6, 1.4) : rand(0.1, 0.3)) * leaf.len;
  leaf.hangFor = rand(0.5, 1.4);
  leaf.state = HANG;
  leaf.t = 0;
}

function step(leaf: Leaf, dt: number, t: number) {
  leaf.t += dt;
  if (leaf.state === HANG) {
    if (leaf.t >= leaf.hangFor) {
      leaf.state = FALL;
      leaf.t = 0;
    }
    return;
  }
  if (leaf.state === REST) {
    if (leaf.t > 2.5) leaf.state = WAIT;
    return;
  }
  if (leaf.state !== FALL) return;
  const g = gustAt(t, leaf.x);
  const [ex, ey] = eddies(leaf.x - 50 * t, leaf.y, t);
  // Air (painting px/s): the breeze carries leaves off to the right, harder in
  // gusts, which also lift them a little; in lulls they drop faster.
  const ax = 18 + 100 * g + 0.8 * ex;
  const ay = 0.6 * ey - 30 * (g - 0.45);
  const f = 1 - Math.exp(-leaf.drag * dt);
  leaf.vx += (ax * leaf.depth - leaf.vx) * f;
  leaf.vy += ((ay + leaf.sink) * leaf.depth - leaf.vy) * f;
  leaf.x += leaf.vx * dt;
  leaf.y += leaf.vy * dt;
  // a leaf only just let go turns slowly at first
  const ramp = Math.min(1, leaf.t / 1.2);
  leaf.phase += leaf.rate * dt * (0.75 + 0.5 * g) * (0.35 + 0.65 * ramp);
  leaf.psi += leaf.spin * dt * (0.5 + g);
  if (leaf.t > 0.8 && leaf.y >= groundAt(leaf.x) + leaf.landAt) {
    leaf.state = REST;
    leaf.t = 0;
  } else if (leaf.x > SW + 40 || leaf.x < -60 || leaf.y > SH + 40 || leaf.y < -60) {
    leaf.state = WAIT;
  }
}

/** Advances the whole tree: leaves let go now and then, in bursts when a gust reaches the crown. */
function advance(leaves: Leaf[], dt: number, t: number) {
  const g = gustAt(t, 650);
  const perSecond = 2.4 + 12 * clamp((g - 0.5) / 0.4, 0, 1) ** 2;
  let n = Math.floor(perSecond * dt + Math.random());
  for (const leaf of leaves) {
    if (n <= 0) break;
    if (leaf.state === WAIT) {
      attach(leaf);
      n--;
    }
  }
  for (const leaf of leaves) step(leaf, dt, t);
}

function LivingScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const crown = new Image();
    const atlas = new Image();
    const leaves: Leaf[] = Array.from({ length: POOL }, () => ({ state: WAIT }) as Leaf);
    let disposed = false;
    let raf = 0;
    let last = 0;
    let clock = 0;
    let scale = 1; // backing-store pixels per painting pixel

    // Start mid-scene, as if the page had been open a while: some leaves
    // trembling on the tree, some falling, some lying in the grass.
    for (; clock < 30; clock += 1 / 20) advance(leaves, 1 / 20, clock);

    const drawLeaf = (leaf: Leaf) => {
      let alpha: number; // rocking about its width
      let beta: number; // roll about its midrib
      let psi = leaf.psi;
      let x = leaf.x;
      let y = leaf.y;
      let fade = 1;
      let air = 0; // 0 = lit like its spot on the tree, 1 = lit as a leaf in open air
      if (leaf.state === HANG) {
        // trembling on its twig, harder as a gust arrives
        const tr = Math.sin(clock * 14 + leaf.phase) * (0.12 + 0.3 * gustAt(clock, leaf.x));
        alpha = 0.2 * tr;
        beta = 0.5 * leaf.lean + tr;
        psi += 0.5 * tr;
        x += 1.5 * tr;
        fade = Math.min(1, leaf.t / 0.35);
      } else if (leaf.state === FALL) {
        const ramp = Math.min(1, leaf.t / 1.2);
        const s = Math.sin(leaf.phase);
        air = ramp;
        if (leaf.mode === FLUTTER) {
          // pendulum: swings sideways, tilted most and rising at the ends of the swing
          x += leaf.swing * s * ramp;
          y -= leaf.swing * 0.3 * s * s * ramp;
          alpha = leaf.rock * s * ramp;
          beta = leaf.lean + 0.35 * Math.sin(leaf.phase * 0.6) * ramp;
          psi += 0.35 * Math.cos(leaf.phase) * ramp;
        } else if (leaf.mode === ROLL) {
          x += leaf.swing * s;
          alpha = 0.3 * Math.sin(leaf.phase * 0.5);
          beta = leaf.lean + leaf.phase;
        } else {
          y += leaf.swing * s;
          alpha = leaf.lean + leaf.phase;
          beta = 0.3 * Math.sin(leaf.phase * 0.5);
        }
      } else {
        // lying in the grass, seen at a low angle, slowly lost from view
        alpha = 1.15;
        beta = 0.3 * leaf.lean;
        air = 1;
        fade = Math.max(0, 1 - leaf.t / 2.5);
      }
      const ca = Math.cos(alpha);
      const sa = Math.sin(alpha);
      const cb = Math.cos(beta);
      const sb = Math.sin(beta);
      const cp = Math.cos(psi);
      const sp = Math.sin(psi);
      // Orthographic projection of the turned leaf: where its width (u) and
      // length (v) axes point on screen, and which way its face points.
      const ux = cb * cp - sb * sa * sp;
      const uy = cb * sp + sb * sa * cp;
      const vx = -ca * sp;
      const vy = ca * cp;
      const nx = sb * cp + cb * sa * sp;
      const ny = sb * sp - cb * sa * cp;
      const nz = cb * ca;
      // In open air the low sun behind the leaves shines through those facing
      // it; one turned to catch the light on its face shines too.
      let lx = SUN.x - x;
      let ly = SUN.y - y;
      let lz = -1400;
      const ll = Math.hypot(lx, ly, lz);
      lx /= ll;
      ly /= ll;
      lz /= ll;
      const dot = (nz >= 0 ? 1 : -1) * (nx * lx + ny * ly + nz * lz);
      const sunlit = leaf.state === REST ? 0.35 : clamp(0.2 + 0.85 * Math.max(-dot, 0.7 * dot), 0, 1);
      // On the tree it is lit like the foliage around it (shade inside the
      // crown, sun at its edges), changing to open-air light as it falls clear.
      const shadeOnTree = leaf.front ? 1 - leaf.sun : 0.7;
      const lit = lerp(0.9 * leaf.sun, sunlit, air);
      const shade = shadeOnTree * (1 - air);

      const k = leaf.len / (LEAF_CELL - 2 * LEAF_PAD);
      const half = LEAF_CELL / 2;
      const sy = leaf.kind * LEAF_CELL;
      ctx.setTransform(scale * ux * k, scale * uy * k, scale * vx * k, scale * vy * k, scale * x, scale * y);
      ctx.globalAlpha = fade;
      ctx.drawImage(atlas, (nz >= 0 ? MID : BACK) * LEAF_CELL, sy, LEAF_CELL, LEAF_CELL, -half, -half, LEAF_CELL, LEAF_CELL);
      if (lit > 0.02) {
        ctx.globalAlpha = fade * lit;
        ctx.drawImage(atlas, LIT * LEAF_CELL, sy, LEAF_CELL, LEAF_CELL, -half, -half, LEAF_CELL, LEAF_CELL);
      }
      if (shade > 0.02) {
        ctx.globalAlpha = fade * shade;
        ctx.drawImage(atlas, SHADE * LEAF_CELL, sy, LEAF_CELL, LEAF_CELL, -half, -half, LEAF_CELL, LEAF_CELL);
      }
    };

    const render = () => {
      // The painting itself is the <img> underneath; this layer holds the
      // leaves and, between the two groups, the crown: leaves leaving from
      // behind it are covered by its foliage until they come out past it.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const leaf of leaves) if (leaf.state !== WAIT && !leaf.front) drawLeaf(leaf);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.globalAlpha = 1;
      const [cx, cy, cw, ch] = CROWN_RECT;
      ctx.drawImage(crown, cx, cy, cw, ch);
      for (const leaf of leaves) if (leaf.state !== WAIT && leaf.front) drawLeaf(leaf);
    };

    const frame = (time: number) => {
      raf = 0;
      if (disposed) return;
      const dt = Math.min((time - (last || time)) / 1000, 0.05);
      last = time;
      clock += dt;
      advance(leaves, dt, clock);
      render();
      raf = requestAnimationFrame(frame);
    };

    const resize = () => {
      // Draw at the screen's resolution (up to 2x the painting) so the leaves
      // stay crisp; CSS object-fit frames the canvas exactly like the image.
      const cover = Math.max(window.innerWidth / SW, window.innerHeight / SH);
      scale = clamp(cover * (window.devicePixelRatio || 1), 1, 2);
      canvas.width = Math.round(SW * scale);
      canvas.height = Math.round(SH * scale);
      ctx.imageSmoothingQuality = 'high';
      render();
    };

    let pending = 2;
    const ready = () => {
      if (--pending || disposed) return;
      resize();
      canvas.classList.add('ready');
      if (!still) raf = requestAnimationFrame(frame);
    };
    for (const [img, src] of [
      [crown, CROWN],
      [atlas, LEAVES],
    ] as const) {
      img.onload = ready;
      img.src = src;
    }
    window.addEventListener('resize', resize);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas className="scene-canvas" ref={canvasRef} aria-hidden="true" />;
}

/**
 * The site-wide screen lock (src/lib/screenLock.ts) already blocks selecting,
 * right-click, copying, dragging and the save/print/devtools shortcuts. This
 * page is touch-locked too (wind-landing.css); iOS Safari ignores touch-action
 * for pinch-zoom, so its gesture events are refused while the page is shown.
 */
function useNoPinchZoom() {
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', block);
    return () => document.removeEventListener('gesturestart', block);
  }, []);
}

export function WindLandingPage() {
  useNoPinchZoom();

  useEffect(() => {
    const previous = document.title;
    document.title = '0dh.in';
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    // The painting and canvas ignore the pointer (wind-landing.css), so they
    // can't be dragged out as a ghost copy or reached by the image menu.
    <div className="wind-landing">
      <img
        className="scene-bg"
        src={BG}
        alt="A leafy tree on a grassy hill at sunrise, its leaves carried off by the wind"
        fetchPriority="high"
        draggable={false}
      />
      <LivingScene />

      <header className="top">
        <span className="brand">
          <LeafIcon size={18} />
          <span>
            0dh
            {/* The domain's dot is the live light; a real "." stays for screen readers and copy-paste. */}
            <span className="sr-only">.</span>
            <span className="live-dot" aria-hidden="true" />
            <b>in</b>
          </span>
        </span>
        <a className="signin" href={SIGN_IN_URL} aria-label="Sign in" draggable={false}>
          <LogIn size={19} aria-hidden="true" />
        </a>
      </header>

      <main className="copy">
        <h1>
          Watching over
          <br />
          <em>every living moment.</em>
        </h1>
      </main>
    </div>
  );
}
