import type { VigilPriority } from '@infusion/shared-types';

/** IEC 60601-1-8 priority markers. */
export const MARK: Record<VigilPriority, string> = { HIGH: '!!!', MEDIUM: '!!', LOW: '!', ADVISORY: 'i' };

export const PATIENT = (label: string | null, encounter: string) => label ?? encounter;

const pad = (n: number) => String(n).padStart(2, '0');

/** Simulated clocks count from scenario start (T+hh:mm:ss); LIVE shows local time. */
export function fmtTime(t: number, simulated: boolean): string {
  if (simulated) {
    const s = Math.max(0, Math.round(t));
    return `T+${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false });
}

export function fmtDur(sec: number): string {
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

export const fmtAgo = (sec: number) => (sec < 1 ? 'just now' : `${fmtDur(sec)} ago`);

export function fmtVal(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '--';
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
}

export const fmtWindow = (s: number) => (s >= 3600 ? `${s / 3600} h` : `${s / 60} min`);
