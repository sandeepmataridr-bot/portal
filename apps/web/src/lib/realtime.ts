import { io, type Socket } from 'socket.io-client';
import { REALTIME_EVENTS } from '@infusion/shared-types';
import { queryClient } from './queryClient';
import type { LiveStatus } from '../features/infusions/api';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

let socket: Socket | null = null;

/**
 * Dashboard-side WS client for the plan's "Real-time live-status push"
 * (§5) — a latency optimization layered on top of the 5s poll `useLiveStatus`
 * already does, never the only path. Connects once for the whole app (called
 * from AuthContext once a session exists) and writes straight into the
 * TanStack Query cache on every `infusion_live_status.updated` event, so
 * every screen using `useLiveStatus`/`InfusionStepsPanel` updates without a
 * manual refresh — no per-page wiring needed beyond this one client.
 */
export function connectRealtime() {
  if (socket) return socket;

  socket = io(`${API_URL}/realtime`, {
    query: { dashboard: 'true' },
    withCredentials: true,
    transports: ['websocket', 'polling'],
  });

  socket.on(REALTIME_EVENTS.infusionLiveStatusUpdated, (status: LiveStatus) => {
    queryClient.setQueryData(['live-status', status.machineId], status);
  });

  socket.on(REALTIME_EVENTS.machineCommandUpdated, (payload: { machineId: string }) => {
    queryClient.invalidateQueries({ queryKey: ['machine-commands', payload.machineId] });
  });

  // A machine's online/offline transition must be immediate, not wait for
  // the fleet table's 15s poll — the remote-command "online-only, never
  // queued" gate (plan § "Super-user remote commands") reads this same
  // status, and a stale "offline" for up to 15s would just be annoying, but
  // a stale "online" for up to 15s after a real disconnect would let a
  // superuser attempt a command against a machine that already dropped.
  socket.on(REALTIME_EVENTS.machineStatusChanged, () => {
    queryClient.invalidateQueries({ queryKey: ['machines'] });
  });

  return socket;
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
}
