import { useLayoutEffect, useRef, useState } from 'react';
import { VIGIL_GOOD_SQI, type VigilPoint, type VigilPriority, type VigilSignalState } from '@infusion/shared-types';
import { GAP_S, fmtDur, fmtTime, fmtUnit, fmtVal, fmtWindow } from './format';

const H = 92;
const L = 38;
const R = 10;
const T = 8;
const B = 18;

export type AlertBand = [number, number, VigilPriority];

function niceTicks(lo: number, hi: number, count = 3): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.5 && ticks.length < 8; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

interface Props {
  sig: VigilSignalState;
  now: number;
  win: number;
  bands: AlertBand[];
  simulated: boolean;
}

export function LineChart({ sig, now, win, bands, simulated }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  // Pointer position and the chart's on-screen box, captured in event handlers (never read from refs during render).
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [focusRect, setFocusRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const [pointerRect, setPointerRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const boxOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width };
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(160, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(160, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const W = width;
  const t0 = now - win;
  const pts = sig.points;
  const good = pts.filter((p) => p[2] >= VIGIL_GOOD_SQI);
  const basis = good.length ? good : pts;
  let lo = Math.min(...basis.map((p) => p[1]));
  let hi = Math.max(...basis.map((p) => p[1]));
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  const padY = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.05, 0.5);
  lo -= padY;
  hi += padY;
  const ticks = niceTicks(lo, hi);
  lo = Math.min(lo, ticks[0]);
  hi = Math.max(hi, ticks[ticks.length - 1]);
  const x = (t: number) => L + ((t - t0) / win) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const clampY = (v: number) => Math.min(H - B, Math.max(T, y(v)));

  let d = '';
  let prev: VigilPoint | null = null;
  for (const p of good) {
    d += `${prev && p[0] - prev[0] <= GAP_S ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`;
    prev = p;
  }
  const lastGood = good[good.length - 1];
  // Gaps between readings (machine, network or server down): shaded, labelled when wide enough.
  const gaps: [number, number][] = [];
  for (let i = 1; i < pts.length; i++) if (pts[i][0] - pts[i - 1][0] > GAP_S) gaps.push([pts[i - 1][0], pts[i][0]]);

  // Hover / keyboard focus: nearest point to the pointer, or the latest one.
  let hover: VigilPoint | null = null;
  let tipPos: { left: number; top: number } | null = null;
  const rect = pointer ? pointerRect : focusRect;
  if (rect && pts.length) {
    const scale = rect.width / W;
    hover = pts[pts.length - 1];
    if (pointer) {
      const px = (pointer.x - rect.left) / scale;
      hover = pts.reduce((best, q) => (Math.abs(x(q[0]) - px) < Math.abs(x(best[0]) - px) ? q : best), pts[0]);
    }
    const ax = pointer ? pointer.x : rect.left + x(hover[0]) * scale;
    const ay = pointer ? pointer.y : rect.top + clampY(hover[1]) * scale;
    const tw = 190;
    let left = ax + 14;
    let top = ay - 74;
    if (left + tw > window.innerWidth - 8) left = ax - tw - 14;
    if (top < 8) top = ay + 16;
    tipPos = { left: Math.max(8, left), top };
  }

  return (
    <div className="chart" ref={box}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        tabIndex={0}
        aria-label={`${sig.label}, last ${fmtWindow(win)}: latest ${fmtVal(sig.value)} ${fmtUnit(sig.unit)}. Use Show values for a table.`}
        onPointerMove={(e) => {
          setPointer({ x: e.clientX, y: e.clientY });
          setPointerRect(boxOf(e.currentTarget));
        }}
        onPointerLeave={() => setPointer(null)}
        onFocus={(e) => setFocusRect(boxOf(e.currentTarget))}
        onBlur={() => setFocusRect(null)}
      >
        {bands.map(([a, b, pri], i) => {
          const xa = Math.max(L, x(a));
          const xb = Math.min(W - R, x(b));
          return xb > xa ? (
            <rect key={i} className={`alert-band ${pri}`} x={xa} y={T} width={Math.max(2, xb - xa)} height={H - T - B} />
          ) : null;
        })}
        {gaps.map(([a, b]) => {
          const xa = Math.max(L, x(a));
          const xb = Math.min(W - R, x(b));
          if (xb <= xa) return null;
          return (
            <g key={`gap${a}`}>
              <title>{`No data for ${fmtDur(b - a)} (${fmtTime(a, simulated)} to ${fmtTime(b, simulated)})`}</title>
              <rect className="gap" x={xa} y={T} width={Math.max(2, xb - xa)} height={H - T - B} />
              {xb - xa >= 46 && (
                <text className="gap-label" x={(xa + xb) / 2} y={T + 12} textAnchor="middle">
                  no data
                </text>
              )}
            </g>
          );
        })}
        {ticks.map((v) => {
          const yy = y(v);
          if (yy < T - 1 || yy > H - B + 1) return null;
          return (
            <g key={v}>
              <line className="grid" x1={L} x2={W - R} y1={yy} y2={yy} />
              <text className="tick" x={L - 6} y={yy + 3} textAnchor="end">
                {Math.abs(v) >= 100 ? v.toFixed(0) : +v.toFixed(1)}
              </text>
            </g>
          );
        })}
        <line className="base" x1={L} x2={W - R} y1={H - B} y2={H - B} />
        {(
          [
            [0, `-${fmtWindow(win)}`, 'start'],
            [0.5, `-${fmtWindow(win / 2)}`, 'middle'],
            [1, 'now', 'end'],
          ] as const
        ).map(([frac, text, anchor]) => (
          <text key={text} className="tick" x={L + frac * (W - L - R)} y={H - 4} textAnchor={anchor}>
            {text}
          </text>
        ))}
        {d && <path className="line" d={d} />}
        {pts
          .filter((p) => p[2] < VIGIL_GOOD_SQI)
          .map((p) => (
            <circle key={`r${p[0]}`} className="ring" cx={x(p[0])} cy={clampY(p[1])} r={4} />
          ))}
        {lastGood && <circle className="last" cx={x(lastGood[0])} cy={y(lastGood[1])} r={3.5} />}
        {!pts.length && (
          <text className="nodata" x={(L + W - R) / 2} y={H / 2} textAnchor="middle">
            No data in this window
          </text>
        )}
        {hover && (
          <g>
            <line className="cross" x1={x(hover[0])} x2={x(hover[0])} y1={T} y2={H - B} />
            <circle className={hover[2] < VIGIL_GOOD_SQI ? 'ring' : 'hover-dot'} cx={x(hover[0])} cy={clampY(hover[1])} r={4.5} />
          </g>
        )}
      </svg>
      {hover && tipPos && (
        <div className="tooltip" style={tipPos}>
          <div className="tv">
            <i />
            {fmtVal(hover[1])} {fmtUnit(sig.unit)}
          </div>
          <div className="tl">
            {sig.label} · {fmtTime(hover[0], simulated)}
          </div>
          {hover[2] < VIGIL_GOOD_SQI && (
            <div className="tq">Low signal quality ({hover[2].toFixed(1)}), ignored by rules</div>
          )}
        </div>
      )}
    </div>
  );
}
