import { useEffect, useRef, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { Leaf as LeafIcon, LogIn } from 'lucide-react';
import { SCENE_LEAVES, SCENE_SIZE, SCENE_SPAWN } from './sceneData';
import './wind-landing.css';

/**
 * Public landing page at the site root (https://0dh.in/): one calm screen.
 * The scene is the owner's painting of a tree on a sunrise hill. The leaves
 * flying in its sky were cut out of it (sceneData.ts); here they are put back
 * exactly where they were painted, then carried off by a gusty, swirling wind
 * while new ones break off the crown: the painting comes alive. The hospital
 * app itself lives behind /login and /app. Styles are scoped under
 * .wind-landing so nothing leaks into the rest of the app.
 */

const BG = '/landing/scene-bg.webp';
const ATLAS = '/landing/scene-leaves.webp';
const { w: SW, h: SH } = SCENE_SIZE;
/** Leaves sinking below this line settle into the meadow. */
const MEADOW_Y = SH * 0.86;
/** Sprites bigger than this are out-of-focus leaves close to the viewer. */
const NEAR = 55;
const MAX_NEAR = 3;

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
  { size: 300, evolve: 0.05, speed: 55, seed: 0 },
  { size: 120, evolve: 0.11, speed: 22, seed: 17.3 },
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

interface Leaf {
  sprite: number; // index into SCENE_LEAVES
  x: number; // centre, painting px
  y: number;
  vx: number;
  vy: number;
  drag: number; // 1/s: how quickly it follows the moving air
  sink: number; // terminal fall speed in still air, px/s
  depth: number; // parallax: leaves nearer the viewer cross the view faster
  flutter: number; // side-to-side swing, px
  tilt: number; // swing-induced rotation, rad
  phase: number;
  omega: number;
  rot: number;
  spin: number;
  flip: number;
  flipRate: number; // 0: glides and wobbles; otherwise tumbles end over end
  age: number;
  fadeIn: boolean; // breaking off the crown, rather than painted or blown in
  landed: number; // seconds since it reached the meadow, -1 while airborne
}

const sizeOf = (i: number) => SCENE_LEAVES[i][6];
const isCut = (i: number) => SCENE_LEAVES[i][7] === 1;
const depthOf = (size: number) => clamp(size / 28, 0.7, 2.2);

function motion(leaf: Leaf, sprite: number, cut: boolean) {
  const size = sizeOf(sprite);
  const near = size > NEAR;
  leaf.sprite = sprite;
  leaf.vx = 0;
  leaf.vy = 0;
  leaf.drag = rand(0.7, 1.8);
  leaf.sink = near ? rand(40, 70) : rand(18, 45);
  leaf.depth = depthOf(size);
  // The leaf cut by the right edge only slides out of view: turning or
  // swinging would show its cut side.
  leaf.flutter = cut ? 0 : rand(0.25, 0.6) * size;
  leaf.tilt = cut ? 0 : rand(0.25, 0.5);
  leaf.phase = 0;
  leaf.omega = rand(2, 3.4);
  leaf.rot = 0;
  leaf.spin = cut ? 0 : rand(-0.8, 0.8);
  leaf.flip = 0;
  leaf.flipRate = !cut && Math.random() < 0.3 ? rand(2, 4.5) * (Math.random() < 0.5 ? -1 : 1) : 0;
  leaf.age = 0;
  leaf.landed = -1;
}

/** One of the painted leaves, exactly where the painting has it. */
function painted(i: number): Leaf {
  const leaf = { x: SCENE_LEAVES[i][4], y: SCENE_LEAVES[i][5], fadeIn: false } as Leaf;
  motion(leaf, i, isCut(i));
  return leaf;
}

/** Reuses a leaf that left the view: a new one breaks off the crown or blows in. */
function respawn(leaf: Leaf, leaves: Leaf[]) {
  const nearFlying = leaves.filter((l) => l !== leaf && sizeOf(l.sprite) > NEAR).length;
  let sprite: number;
  do sprite = Math.floor(Math.random() * SCENE_LEAVES.length);
  while (isCut(sprite) || (sizeOf(sprite) > NEAR && (nearFlying >= MAX_NEAR || Math.random() < 0.6)));
  const size = sizeOf(sprite);
  if (size <= NEAR && Math.random() < 0.8) {
    // break off the crown, mostly on its sunlit downwind side
    let p: readonly number[];
    do p = SCENE_SPAWN[Math.floor(Math.random() * SCENE_SPAWN.length)];
    while (Math.random() > (p[0] - 300) / 700);
    leaf.x = p[0];
    leaf.y = p[1];
    leaf.fadeIn = true;
  } else {
    leaf.x = -size; // blown in from trees beyond the left edge
    leaf.y = rand(0.04, 0.6) * SH;
    leaf.fadeIn = false;
  }
  motion(leaf, sprite, false);
  leaf.phase = rand(0, Math.PI * 2);
  leaf.vx = rand(10, 40);
}

function step(leaf: Leaf, leaves: Leaf[], dt: number, t: number) {
  const ramp = Math.min(1, leaf.age / 1.5); // painted leaves start still and get going
  leaf.age += dt;
  if (leaf.landed >= 0) leaf.landed += dt;
  const g = gustAt(t, leaf.x);
  const [ex, ey] = eddies(leaf.x - 60 * t, leaf.y, t);
  const ax = 32 + 78 * g + ex;
  // The breeze nearly carries the leaves' weight, so they ride across the
  // sky as in the painting, lifted in gusts and dropped in lulls.
  let ay = -0.82 * leaf.sink - 34 * (g - 0.45) + ey;
  if (leaf.fadeIn && leaf.age < 2.5) ay -= 40 * (1 - leaf.age / 2.5) * g; // air deflected up over the crown
  const f = 1 - Math.exp(-leaf.drag * dt);
  leaf.vx += (ax * leaf.depth - leaf.vx) * f;
  leaf.vy += ((ay + leaf.sink) * leaf.depth - leaf.vy) * f;
  if (isCut(leaf.sprite)) leaf.vx = Math.max(leaf.vx, 24);
  leaf.x += leaf.vx * dt;
  leaf.y += leaf.vy * dt;
  leaf.phase += leaf.omega * dt * (0.8 + 0.5 * g);
  leaf.rot += leaf.spin * dt * (0.6 + g) * ramp;
  leaf.flip += leaf.flipRate * dt * (0.7 + 0.6 * g) * ramp;
  if (leaf.landed < 0 && leaf.y > MEADOW_Y && leaf.age > 1) leaf.landed = 0;
  const size = sizeOf(leaf.sprite);
  if (leaf.landed > 1 || leaf.x > SW + size || leaf.x < -2 * size - 60 || leaf.y < -size - 80 || leaf.y > SH + size) {
    respawn(leaf, leaves);
  }
}

/** Where a painting pixel lands on screen, given the <img>'s object-fit: cover box. */
function coverTransform(img: HTMLImageElement) {
  const box = img.getBoundingClientRect();
  const [px = 0.5, py = 0.5] = getComputedStyle(img)
    .objectPosition.split(' ')
    .map((v) => (v.endsWith('%') ? parseFloat(v) / 100 : 0.5));
  const k = Math.max(box.width / SW, box.height / SH);
  return { k, ox: box.left + (box.width - SW * k) * px, oy: box.top + (box.height - SH * k) * py };
}

function SceneLeaves({ sceneRef }: { sceneRef: RefObject<HTMLImageElement | null> }) {
  const backRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const back = backRef.current;
    const front = frontRef.current;
    const bctx = back?.getContext('2d');
    const fctx = front?.getContext('2d');
    if (!back || !front || !bctx || !fctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const atlas = new Image();
    let underside: CanvasImageSource = atlas; // the paler back of a tumbling leaf
    const leaves = SCENE_LEAVES.map((_, i) => painted(i));
    let disposed = false;
    let raf = 0;
    let last = 0;
    let clock = 0;
    let width = 0;
    let height = 0;
    let view = { k: 1, ox: 0, oy: 0 };

    const draw = (ctx: CanvasRenderingContext2D, leaf: Leaf) => {
      const [ax, ay, w, h] = SCENE_LEAVES[leaf.sprite];
      const ramp = Math.min(1, leaf.age / 1.5);
      const s = Math.sin(leaf.phase);
      // Pendulum swing while falling, rising a little at each end of the swing.
      const x = leaf.x + leaf.flutter * s * ramp;
      const y = leaf.y - leaf.flutter * 0.3 * s * s * ramp;
      const turn = leaf.flipRate ? Math.cos(leaf.flip) : 1 - 0.3 * Math.abs(s) * ramp;
      const alpha = (leaf.fadeIn ? Math.min(1, leaf.age / 0.6) : 1) * (leaf.landed >= 0 ? Math.max(0, 1 - leaf.landed) : 1);
      if (alpha <= 0) return;
      const { k, ox, oy } = view;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(ox + x * k, oy + y * k);
      ctx.rotate(leaf.rot + leaf.tilt * Math.cos(leaf.phase) * ramp);
      // Turning edge-on to the viewer: squash one axis; past edge-on, show the underside.
      ctx.scale(Math.sign(turn || 1) * Math.max(0.08, Math.abs(turn)), 1);
      ctx.drawImage(turn < 0 ? underside : atlas, ax, ay, w, h, (-w / 2) * k, (-h / 2) * k, w * k, h * k);
      ctx.restore();
    };

    const render = () => {
      bctx.clearRect(0, 0, width, height);
      fctx.clearRect(0, 0, width, height);
      for (const leaf of leaves) draw(sizeOf(leaf.sprite) > NEAR ? fctx : bctx, leaf);
    };

    const frame = (time: number) => {
      raf = 0;
      if (disposed) return;
      const dt = Math.min((time - (last || time)) / 1000, 0.05);
      last = time;
      clock += dt;
      for (const leaf of leaves) step(leaf, leaves, dt, clock);
      render();
      raf = requestAnimationFrame(frame);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      for (const [c, ctx] of [
        [back, bctx],
        [front, fctx],
      ] as const) {
        c.width = Math.round(width * dpr);
        c.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingQuality = 'high';
      }
      if (sceneRef.current) view = coverTransform(sceneRef.current);
      render();
    };

    atlas.onload = () => {
      if (disposed) return;
      if ('filter' in CanvasRenderingContext2D.prototype) {
        const c = document.createElement('canvas');
        c.width = atlas.naturalWidth;
        c.height = atlas.naturalHeight;
        const g = c.getContext('2d');
        if (g) {
          g.filter = 'saturate(0.7) brightness(1.15)';
          g.drawImage(atlas, 0, 0);
          underside = c;
        }
      }
      resize();
      if (!still) raf = requestAnimationFrame(frame);
    };
    atlas.src = ATLAS;
    window.addEventListener('resize', resize);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [sceneRef]);

  return (
    <>
      <canvas className="leaf-canvas back" ref={backRef} aria-hidden="true" />
      <canvas className="leaf-canvas front" ref={frontRef} aria-hidden="true" />
    </>
  );
}

export function WindLandingPage() {
  const sceneRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const previous = document.title;
    document.title = '0dh.in';
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="wind-landing">
      <img
        ref={sceneRef}
        className="scene-bg"
        src={BG}
        alt="A leafy tree on a grassy hill at sunrise, its leaves carried off by the wind"
        fetchPriority="high"
      />
      <SceneLeaves sceneRef={sceneRef} />

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
        <Link className="signin" to="/login">
          <LogIn size={16} /> Staff sign in
        </Link>
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
