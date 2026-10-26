import type { VigilAlertView, VigilState } from '@infusion/shared-types';
import { apiFetch } from '../../lib/api';
import type { AlertBand } from './LineChart';
import { poll } from './store';

/** Shared by the central station and the machine cards. */
export type Ready = Extract<VigilState, { ready: true }>;

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function post(path: string, body?: unknown) {
  await apiFetch(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  await poll();
}

/** Alert intervals per encounter, from the log plus active alerts. */
export function alertBands(state: Ready, encounter: string): AlertBand[] {
  const open = new Map<string, [number, VigilAlertView['priority']]>();
  const bands: AlertBand[] = [];
  for (const e of [...state.log].reverse()) {
    if (e.encounter !== encounter) continue;
    if (e.kind === 'raised') open.set(e.id, [e.at, e.priority]);
    if (e.kind === 'resolved' && open.has(e.id)) {
      const [at, pri] = open.get(e.id)!;
      bands.push([at, e.at, pri]);
      open.delete(e.id);
    }
  }
  for (const [at, pri] of open.values()) bands.push([at, state.now, pri]);
  for (const a of state.alerts) {
    if (a.encounter === encounter && !bands.some((b) => b[0] === a.raised)) bands.push([a.raised, state.now, a.priority]);
  }
  return bands;
}
