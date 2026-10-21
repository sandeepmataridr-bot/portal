import { VIGIL_DEFAULT_WINDOW, VIGIL_STALE_S, VIGIL_WINDOWS, type VigilState } from '@infusion/shared-types';
import { ApiError, apiFetch, setAccessToken } from '../../lib/api';

/**
 * The central station's live state, kept OUTSIDE React (plan §3.1: alarm
 * display never depends on React rendering). One poller per open screen
 * fetches /vigil/state once a second; components read it through
 * useSyncExternalStore, and the DOM-only alarm fallback (fallback.ts) reads
 * it directly, so alarms keep updating even if the React tree has crashed.
 */

export const POLL_MS = 1000;
/** A stream gap over 5 s means "no live data" (operating level 3 for this screen). */
export const LOST_AFTER_MS = VIGIL_STALE_S * 1000;

export type Connection = 'connecting' | 'ok' | 'retrying' | 'lost' | 'signed_out';

export interface StoreSnapshot {
  state: VigilState | null;
  connection: Connection;
  /** Date.now() of the last successful poll, 0 if none */
  lastOk: number;
  window: number;
}

const WINDOW_KEY = 'vigil.window';

function storedWindow(): number {
  try {
    const w = Number(localStorage.getItem(WINDOW_KEY));
    return (VIGIL_WINDOWS as readonly number[]).includes(w) ? w : VIGIL_DEFAULT_WINDOW;
  } catch {
    return VIGIL_DEFAULT_WINDOW;
  }
}

let snapshot: StoreSnapshot = { state: null, connection: 'connecting', lastOk: 0, window: storedWindow() };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let running = 0;
let inFlight = false;

function emit(next: Partial<StoreSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSnapshot(): StoreSnapshot {
  return snapshot;
}

/** Access tokens live 15 min; a station screen stays open for hours, so refresh once on 401. */
async function refreshSession(): Promise<boolean> {
  try {
    const res = await apiFetch<{ accessToken: string }>('/auth/refresh', { method: 'POST' });
    setAccessToken(res.accessToken);
    return true;
  } catch {
    return false;
  }
}

async function fetchState(): Promise<VigilState> {
  const path = `/vigil/state?window=${snapshot.window}`;
  try {
    return await apiFetch<VigilState>(path, { cache: 'no-store' });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && (await refreshSession())) {
      return apiFetch<VigilState>(path, { cache: 'no-store' });
    }
    throw e;
  }
}

export async function poll(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (inFlight) return;
  inFlight = true;
  try {
    const state = await fetchState();
    emit({ state, connection: 'ok', lastOk: Date.now() });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      emit({ connection: 'signed_out' });
    } else {
      const lost = Date.now() - snapshot.lastOk > LOST_AFTER_MS;
      emit({ connection: lost ? 'lost' : 'retrying' });
    }
  } finally {
    inFlight = false;
    if (running > 0) timer = setTimeout(() => void poll(), POLL_MS);
  }
}

/** Starts polling; returns the stop function. Reference-counted for StrictMode double mounts. */
export function start(): () => void {
  running += 1;
  if (running === 1) void poll();
  return () => {
    running -= 1;
    if (running === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function setWindow(window: number): void {
  try {
    localStorage.setItem(WINDOW_KEY, String(window));
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
  emit({ window });
  void poll();
}

/** Operating level shown in the banner: 3 when this screen has lost the server. */
export function effectiveLevel(s: StoreSnapshot): 0 | 1 | 2 | 3 | null {
  if (s.connection === 'lost' || s.connection === 'signed_out') return 3;
  if (!s.state || !s.state.ready) return null;
  return s.state.operatingLevel;
}
