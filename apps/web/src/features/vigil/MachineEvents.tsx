import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MACHINE_LOG_KINDS, type MachineAlarmsView, type MachineLogEntryView, type MachineLogKind } from '@infusion/shared-types';
import { apiFetch } from '../../lib/api';
import { fmtAgo } from './format';
import { useNow } from './useNow';

const PRIORITY = ['', 'Low', 'Medium', 'High'] as const;
const PRIORITY_CLASS = ['', 'low', 'medium', 'high'] as const;
const KIND_LABEL: Record<MachineLogKind, string> = { treatment: 'Treatment', alarm: 'Alarm', system: 'System' };

const clock = (iso: string) => new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/**
 * The machine's own active alarms, as it reports them (ECMO/EBOO HMI). Shown
 * only: acknowledging and silencing happen on the machine, never here.
 */
export function MachineAlarms({ machineId }: { machineId: string }) {
  const now = useNow();
  const { data } = useQuery({
    queryKey: ['machine-alarms', machineId],
    queryFn: () => apiFetch<MachineAlarmsView>(`/vigil/machines/${encodeURIComponent(machineId)}/alarms`),
    refetchInterval: 5000,
  });
  if (!data?.reportedAt) return null;
  const age = Math.max(0, (now - Date.parse(data.reportedAt)) / 1000);
  const silenced = data.silencedUntil && Date.parse(data.silencedUntil) > now;
  return (
    <div className="m-alarms" aria-label="Machine alarms">
      <div className="m-section">
        Machine alarms <span className="m-section-note">as the machine reports them · {fmtAgo(age)}</span>
      </div>
      {data.alarms.length === 0 ? (
        <p className="m-alarms-none">No active alarms on the machine.</p>
      ) : (
        <ul>
          {data.alarms.map((a) => (
            <li key={`${a.code}-${a.since}`} className={`m-alarm ${PRIORITY_CLASS[a.priority]}`}>
              <span className={`pri-chip ${PRIORITY_CLASS[a.priority]}`}>{PRIORITY[a.priority]}</span>
              <b>{a.code}</b> {a.text}
              <span className="m-alarm-meta">
                since {clock(a.since)}
                {a.acknowledged ? ' · acknowledged on the machine' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {silenced && <p className="m-alarms-note">Silenced on the machine until {clock(data.silencedUntil!)}</p>}
    </div>
  );
}

/** The machine's own treatment, alarm and system logs, newest first, opened on demand. */
export function MachineLog({ machineId }: { machineId: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<MachineLogKind>('treatment');
  const [pages, setPages] = useState(1);
  const { data, isFetching } = useQuery({
    queryKey: ['machine-log', machineId, kind, pages],
    queryFn: () => apiFetch<MachineLogEntryView[]>(`/vigil/machines/${encodeURIComponent(machineId)}/log?kind=${kind}&limit=${pages * 50}`),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  });
  return (
    <div className="m-log">
      <button type="button" className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'Hide machine log' : 'Machine log'}
      </button>
      {open && (
        <>
          <div className="seg m-log-tabs" role="radiogroup" aria-label="Machine log">
            {MACHINE_LOG_KINDS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={k === kind} onClick={() => (setKind(k), setPages(1))}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          {!data ? (
            <p className="empty">{isFetching ? 'Loading…' : ''}</p>
          ) : data.length === 0 ? (
            <p className="empty">No {KIND_LABEL[kind].toLowerCase()} log entries from this machine.</p>
          ) : (
            <div className="vals-scroll">
              <table className="vals">
                <thead>
                  {kind === 'treatment' ? (
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th>Value</th>
                    </tr>
                  ) : kind === 'alarm' ? (
                    <tr>
                      <th>Time</th>
                      <th>Alarm</th>
                      <th>Value</th>
                      <th>Limit</th>
                      <th>Status</th>
                    </tr>
                  ) : (
                    <tr>
                      <th>Time</th>
                      <th>Category</th>
                      <th>Event</th>
                      <th>Details</th>
                      <th>Result</th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {data.map((e) =>
                    kind === 'treatment' ? (
                      <tr key={e.id}>
                        <td>{clock(e.at)}</td>
                        <td>{e.event}</td>
                        <td>{e.value ?? ''}</td>
                      </tr>
                    ) : kind === 'alarm' ? (
                      <tr key={e.id}>
                        <td>{clock(e.at)}</td>
                        <td>
                          {e.priority ? <span className={`pri-chip ${PRIORITY_CLASS[e.priority]}`}>{PRIORITY[e.priority]}</span> : null} {e.event}
                        </td>
                        <td>{e.value ?? '—'}</td>
                        <td>{e.details ?? '—'}</td>
                        <td>{e.result ?? ''}</td>
                      </tr>
                    ) : (
                      <tr key={e.id}>
                        <td>{clock(e.at)}</td>
                        <td>{e.category ?? ''}</td>
                        <td>{e.event}</td>
                        <td>{e.details ?? ''}</td>
                        <td>{e.result ?? ''}</td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
          {data && data.length >= pages * 50 && (
            <button type="button" className="link" onClick={() => setPages(pages + 1)}>
              Older entries
            </button>
          )}
        </>
      )}
    </div>
  );
}
