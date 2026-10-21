import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  VIGIL_GOOD_SQI,
  type VigilAlertView,
  type VigilLogEntry,
  type VigilMachineState,
  type VigilSignalState,
  type VigilState,
} from '@infusion/shared-types';
import { useAuth } from '../../auth/AuthContext';
import { apiFetch } from '../../lib/api';
import { hideFallback, showFallback } from './fallback';
import { MARK, PATIENT, fmtAgo, fmtDur, fmtTime, fmtVal, fmtWindow } from './format';
import { LineChart, type AlertBand } from './LineChart';
import { effectiveLevel, getSnapshot, poll, setWindow, start, subscribe, type Connection } from './store';
import './central-station.css';

type Ready = Extract<VigilState, { ready: true }>;

const LEVELS: Record<number, [string, string]> = {
  0: ['Level 0 · Full operation', 'All machines reporting; safety floor and core rules running.'],
  1: ['Level 1 · Degraded', ''],
  2: ['Level 2 · Safety floor only', ''],
  3: ['Level 3 · Central station offline', 'This screen has lost the server. Use the bedside devices and their alarms.'],
};
const KIND_MARK: Record<VigilLogEntry['kind'], string> = { raised: '▲', resolved: '✓', acknowledged: '◉' };
const STATUS_TEXT: Record<VigilMachineState['status'], string> = {
  ok: 'Receiving',
  waiting: 'Waiting for data',
  no_data: 'No data',
  unconfirmed: 'Association not confirmed',
  unassociated: 'Not associated',
};
const CONN_TEXT: Record<Connection, string> = {
  connecting: 'Connecting',
  ok: 'Connected',
  retrying: 'Retrying',
  lost: 'Disconnected',
  signed_out: 'Session expired',
};
const PLACEMENT: Record<string, string> = { safety_floor: 'safety floor', core: 'core' };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function post(path: string, body?: unknown) {
  await apiFetch(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  await poll();
}

function useStore() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Catches render errors in the main view; the DOM-only fallback keeps listing alarms. */
class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    showFallback(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// ── theme ─────────────────────────────────────────────────────────────────

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('vigil.theme') ?? '';
    } catch {
      return '';
    }
  });
  const toggle = () => {
    const current = theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem('vigil.theme', next);
    } catch {
      // not remembered
    }
  };
  return [theme, toggle];
}

// ── page ──────────────────────────────────────────────────────────────────

export function CentralStationPage() {
  const snap = useStore();
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    const stop = start();
    const onError = (e: ErrorEvent) => showFallback(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => showFallback(e.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      stop();
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      hideFallback();
    };
  }, []);

  const s = snap.state;
  const ready = s && s.ready ? s : null;
  const notReady = s && !s.ready ? (s as Extract<VigilState, { ready: false }>) : null;
  useEffect(() => {
    const n = ready ? ready.alerts.length : 0;
    document.title = `${n ? `(${n}) ` : ''}${s?.mode === 'test' ? '[TEST] ' : ''}Vigil Central Station`;
    return () => {
      document.title = 'Infusion Platform';
    };
  }, [ready, s?.mode]);

  const level = effectiveLevel(snap);
  const stale = snap.connection === 'lost' || snap.connection === 'signed_out';

  return (
    <div className={`vigil-cs${stale ? ' is-stale' : ''}`} data-theme={theme || undefined}>
      <TopBar state={s} connection={snap.connection} onTheme={toggleTheme} />
      <OperatingLevel level={level} reasons={level === 3 || !ready ? [] : ready.operatingReasons} />
      {s?.controller && <Guard><TestBar state={s} /></Guard>}
      {stale && (
        <div className="conn-lost" role="alert">
          {snap.connection === 'signed_out' ? (
            <>
              <strong>Your session has expired.</strong> Values below are frozen and may be out of date.{' '}
              <Link to="/login">Log in again</Link>; meanwhile use the bedside devices.
            </>
          ) : (
            <>
              <strong>Connection to the server lost.</strong> Values below are frozen at{' '}
              {snap.lastOk ? new Date(snap.lastOk).toLocaleTimeString([], { hour12: false }) : 'start-up'} and may be out of
              date. Use the bedside devices.
            </>
          )}
        </div>
      )}
      {notReady?.error && (
        <div className="conn-lost" role="alert">
          <strong>Vigil is not running.</strong> {notReady.error}
        </div>
      )}
      <main className="layout">
        <aside className="side">
          {/* Alarms render on their own, outside the guarded main view. */}
          <AlertsPanel state={ready} />
          <Guard>
            <EventLog state={ready} />
            <RulesPanel state={ready} />
          </Guard>
        </aside>
        <section className="machines-col" aria-labelledby="machines-h">
          <Guard>
            <Machines state={ready} window={snap.window} />
          </Guard>
        </section>
      </main>
      <footer className="footer">
        Vigil is a secondary alarm display. The bedside devices&apos; own alarms remain primary. Rule thresholds are
        placeholders pending clinical sign-off.
        {ready && (
          <span className="muted">
            Node {ready.nodeId} · {ready.stats.observations.toLocaleString()} observations
          </span>
        )}
      </footer>
    </div>
  );
}

// ── header, banners ───────────────────────────────────────────────────────

function TopBar({ state, connection, onTheme }: { state: VigilState | null; connection: Connection; onTheme: () => void }) {
  const { user, logout } = useAuth();
  const ready = state && state.ready ? state : null;
  return (
    <header className="topbar">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M2 17h7l3-8 5 15 4-11 2 4h7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="brand-text">
          <strong>Vigil</strong>
          <span>ECMO central station</span>
        </div>
      </div>
      <div className="unit-info">
        <span className="unit-name">{ready?.unitId ?? '-'}</span>
        <span className="muted">{ready?.tenantId}</span>
      </div>
      {state && <div className={`mode-badge ${state.mode}`}>{state.mode === 'test' ? 'TEST' : 'LIVE'}</div>}
      <div className="clock-block">
        <span className="clock">{ready ? fmtTime(ready.now, ready.simulatedClock) : '--:--:--'}</span>
        <span className="muted">{ready ? (ready.simulatedClock ? 'simulated clock' : 'local time') : 'connecting'}</span>
      </div>
      <div className={`conn ${connection === 'ok' ? 'ok' : connection === 'lost' || connection === 'signed_out' ? 'bad' : ''}`} role="status">
        <span className="conn-dot" />
        <span>{CONN_TEXT[connection]}</span>
      </div>
      <button className="icon-btn" type="button" onClick={onTheme} aria-label="Switch light or dark theme" title="Switch theme">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
        </svg>
      </button>
      <div className="user-box">
        <span className="muted">{user?.loginId}</span>
        <Link className="link" to="/app">
          Dashboard
        </Link>
        <button className="link" type="button" onClick={() => void logout()}>
          Log out
        </button>
      </div>
    </header>
  );
}

/** Part of the page shell: no control hides it (plan §3.1). */
function OperatingLevel({ level, reasons }: { level: 0 | 1 | 2 | 3 | null; reasons: string[] }) {
  if (level === null) {
    return (
      <div className="op-level lvl-x" role="status" aria-live="polite">
        <strong>Operating level: unknown</strong>
        <span>Connecting to the server.</span>
      </div>
    );
  }
  const [name, text] = LEVELS[level];
  return (
    <div className={`op-level lvl-${level}`} role="status" aria-live="polite">
      <strong>{name}</strong>
      <span>{reasons.length ? `${reasons.join('; ')}.` : text}</span>
    </div>
  );
}

function TestBar({ state }: { state: VigilState }) {
  const c = state.controller!;
  const ready = state.ready ? state : null;
  const [scenario, setScenario] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sc = ready?.scenario;

  const restart = async () => {
    setBusy(true);
    setError('');
    try {
      await post('/vigil/test/run', { scenario: scenario ?? c.scenario, speed: c.speed });
      setScenario(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const changeSpeed = async (speed: number) => {
    setError('');
    try {
      await post('/vigil/test/speed', { speed });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const status = ready?.finished ? (ready.stopped ? 'stopped' : 'finished') : `${c.speed}×`;

  return (
    <div className="test-bar">
      <div className="test-label">
        <strong>TEST MODE</strong>
        <span>Simulated data from a patient scenario. Not for clinical use.</span>
      </div>
      <div className="test-controls">
        <label>
          Scenario
          <select value={scenario ?? c.scenario} onChange={(e) => setScenario(e.target.value)}>
            {c.scenarios.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Speed
          <select value={c.speed} onChange={(e) => void changeSpeed(Number(e.target.value))}>
            {c.speeds.map((n) => (
              <option key={n} value={n}>
                {n}×
              </option>
            ))}
          </select>
        </label>
        <button className="btn" type="button" disabled={busy} onClick={() => void restart()}>
          Restart
        </button>
      </div>
      {sc && ready && (
        <div className="progress" aria-label="Scenario progress">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${(Math.min(1, ready.now / sc.duration) * 100).toFixed(2)}%` }} />
            {sc.annotations.map((a) => (
              <div
                key={a.at}
                className="progress-mark"
                title={`Annotated event ${fmtTime(a.at, true)}: ${a.label}`}
                style={{ left: `${((a.at / sc.duration) * 100).toFixed(2)}%` }}
              />
            ))}
          </div>
          <span className="muted">
            {fmtTime(ready.now, true)} of {fmtDur(sc.duration)} · {status}
          </span>
        </div>
      )}
      {sc && <p className="scenario-desc muted">{sc.description}</p>}
      {(error || c.error) && (
        <p className="form-error" role="alert">
          {error || `Scenario failed: ${c.error}`}
        </p>
      )}
    </div>
  );
}

// ── alarms ────────────────────────────────────────────────────────────────

function AlertsPanel({ state }: { state: Ready | null }) {
  const { user } = useAuth();
  const alerts = state?.alerts ?? [];
  return (
    <section className="panel alerts-panel" aria-labelledby="alerts-h">
      <div className="panel-head">
        <h2 id="alerts-h">
          Active alerts <span className="count">{alerts.length}</span>
        </h2>
      </div>
      <p className="ack-as">Acknowledging as {user?.loginId}</p>
      <div className="alerts">
        {alerts.map((a) => (
          <AlertCard key={a.alertId} alert={a} state={state!} />
        ))}
      </div>
      {!alerts.length && <p className="empty">No active alerts.</p>}
    </section>
  );
}

function AlertCard({ alert: a, state }: { alert: VigilAlertView; state: Ready }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const acked = a.state === 'ACKNOWLEDGED';
  const acknowledge = async () => {
    setBusy(true);
    setError('');
    try {
      await post(`/vigil/alerts/${encodeURIComponent(a.alertId)}/ack`);
    } catch (e) {
      setError(`Not acknowledged: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`alert pri-${a.priority}${acked ? ' is-acked' : ''}`} role="group" aria-label={`${a.priority} priority alert: ${a.rule}`}>
      <div className="pri">
        <span className="mk">{MARK[a.priority]}</span>
        <span>{a.priority}</span>
      </div>
      <div className="alert-title">
        {a.rule}
        <span className="tag">
          {a.version} · {PLACEMENT[a.placement]}
          {a.testMode ? ' · TEST' : ''}
        </span>
      </div>
      <div className="alert-expl">{a.explanation}</div>
      <div className="alert-meta">
        Patient {PATIENT(a.patientLabel, a.encounter)} · raised {fmtTime(a.raised, state.simulatedClock)} (
        {fmtAgo(state.now - a.raised)}) · id {a.id}
      </div>
      <div className="alert-actions">
        {acked ? (
          <span className="acked">✓ Acknowledged by {a.acknowledgedBy}</span>
        ) : (
          <button className="btn" type="button" disabled={busy} onClick={() => void acknowledge()}>
            Acknowledge
          </button>
        )}
        {error && <span className="form-error">{error}</span>}
      </div>
    </div>
  );
}

function EventLog({ state }: { state: Ready | null }) {
  const log = state?.log ?? [];
  return (
    <section className="panel" aria-labelledby="log-h">
      <h2 id="log-h">Event log</h2>
      <ol className="log">
        {log.map((e, i) => (
          <li key={`${e.id}-${e.kind}-${i}`}>
            <time>{fmtTime(e.at, state!.simulatedClock)}</time>
            <span className={`k k-${e.kind} ${e.priority}`} title={e.kind}>
              {KIND_MARK[e.kind]}
            </span>
            <span className="what">
              {e.kind === 'raised' ? `${e.priority} ` : ''}
              {e.rule} · {e.encounter}
              <small>{e.kind === 'raised' ? e.explanation : e.kind === 'acknowledged' ? `acknowledged by ${e.by}` : e.explanation || 'resolved'}</small>
            </span>
          </li>
        ))}
      </ol>
      {!log.length && <p className="empty">Nothing yet.</p>}
    </section>
  );
}

function RulesPanel({ state }: { state: Ready | null }) {
  return (
    <section className="panel" aria-labelledby="rules-h">
      <h2 id="rules-h">Rules running</h2>
      <ul className="rules">
        {(state?.rules ?? []).map((r) => (
          <li key={r.key}>
            <span>{r.key}</span>
            <span className="muted">
              {r.priority.toLowerCase()} · {PLACEMENT[r.placement]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── machines ──────────────────────────────────────────────────────────────

/** Alert intervals per encounter, from the log plus active alerts. */
function alertBands(state: Ready, encounter: string): AlertBand[] {
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

function Machines({ state, window: win }: { state: Ready | null; window: number }) {
  const machines = state?.machines ?? [];
  return (
    <>
      <div className="toolbar">
        <h2 id="machines-h">
          Machines <span className="count">{machines.length}</span>
        </h2>
        {state && (
          <div className="seg" role="radiogroup" aria-label="Chart time window">
            {state.windows.map((w) => (
              <button key={w} type="button" role="radio" aria-checked={w === win} onClick={() => setWindow(w)}>
                {fmtWindow(w)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="machines">
        {state && machines.map((m) => <MachineCard key={m.deviceId} m={m} state={state} />)}
      </div>
      {!machines.length && (
        <p className="empty big">
          {state ? 'No ECMO machines are tagged to a patient or sending data yet.' : 'Waiting for the server.'}
        </p>
      )}
    </>
  );
}

function MachineCard({ m, state }: { m: VigilMachineState; state: Ready }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bands = m.encounterId ? alertBands(state, m.encounterId) : [];
  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await post(`/vigil/associations/${encodeURIComponent(m.associationId!)}/confirm`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`machine${m.status === 'no_data' ? ' is-nodata' : ''}`} data-alert={m.alertPriority ?? ''} aria-label={`Machine ${m.deviceId}`}>
      <div className="m-head">
        <div>
          <h3>{m.deviceId}</h3>
          <div className="m-kind">
            {m.kind} · {m.driver}
            {m.unmapped ? ` · ${m.unmapped} unmapped values` : ''}
          </div>
        </div>
        <span className={`status ${m.status}`}>
          {m.status === 'no_data' && m.age != null ? `No live data for ${fmtDur(m.age)}` : STATUS_TEXT[m.status]}
        </span>
      </div>
      <p className="m-patient">
        {m.encounterId ? (
          <>
            Patient <b>{PATIENT(m.patientLabel, m.encounterId)}</b>
            {m.therapy && ` · ${m.therapy}${m.therapyDetail ? ` ${m.therapyDetail}` : ''}`}
            {m.confirmedBy ? ` · confirmed by ${m.confirmedBy}` : ' · not confirmed, rules paused'}
          </>
        ) : (
          'Not associated with a patient. Data is recorded but no rules run.'
        )}
        {m.alertPriority && (
          <span className="m-alert">
            {MARK[m.alertPriority]} {m.alertPriority} alert
          </span>
        )}
      </p>
      {m.status === 'unconfirmed' && m.associationId && (
        <div className="confirm-box">
          <span>Check at the bedside that this console is on this patient before rules start running.</span>
          <button className="btn" type="button" disabled={busy} onClick={() => void confirm()}>
            Confirm association
          </button>
          {error && <span className="form-error">{error}</span>}
        </div>
      )}
      <div className="m-signals">
        {m.signals.map((sig) =>
          sig.kind === 'numeric' ? (
            <NumericSignal key={sig.code} sig={sig} stale={m.status === 'no_data'} bands={bands} state={state} />
          ) : sig.kind === 'lab' ? (
            <LabSignal key={sig.code} sig={sig} state={state} />
          ) : (
            <SettingSignal key={sig.code} sig={sig} state={state} />
          ),
        )}
      </div>
    </article>
  );
}

function QualityChip({ sig, stale }: { sig: VigilSignalState; stale: boolean }) {
  if (stale) return <span className="chip bad">NO LIVE DATA</span>;
  if (!(sig.sqi < VIGIL_GOOD_SQI && sig.flags.length)) return null;
  return (
    <span className="chip">
      ⚠ {sig.flags.filter((f) => f !== 'SETTING').join(', ')} · SQI {sig.sqi.toFixed(1)}
    </span>
  );
}

function NumericSignal({ sig, stale, bands, state }: { sig: VigilSignalState; stale: boolean; bands: AlertBand[]; state: Ready }) {
  const [showTable, setShowTable] = useState(false);
  const hasLow = sig.points.some((p) => p[2] < VIGIL_GOOD_SQI);
  return (
    <div className={`sig${stale ? ' is-old' : ''}`}>
      <div className="sig-head">
        <span className="sig-label">{sig.label}</span>
        <QualityChip sig={sig} stale={stale} />
      </div>
      <div className="sig-body">
        <div className="sig-value">
          <span className="val">{fmtVal(sig.value)}</span>
          <span className="unit">{sig.unit}</span>
          <span className="sig-age">updated {fmtAgo(sig.age)}</span>
        </div>
        <LineChart sig={sig} now={state.now} win={state.window} bands={bands} simulated={state.simulatedClock} />
      </div>
      <div className="sig-foot">
        <span className="legend">
          {hasLow && (
            <>
              <span>
                <i className="key-line" />
                measured
              </span>
              <span>
                <i className="key-ring" />
                low quality, ignored by rules
              </span>
            </>
          )}
        </span>
        <button className="link" type="button" aria-expanded={showTable} onClick={() => setShowTable(!showTable)}>
          {showTable ? 'Hide values' : 'Show values'}
        </button>
      </div>
      {showTable && (
        <table className="vals">
          <thead>
            <tr>
              <th>Time</th>
              <th className="num">{sig.unit}</th>
              <th className="num">Quality</th>
            </tr>
          </thead>
          <tbody>
            {sig.points
              .slice(-10)
              .reverse()
              .map((p) => (
                <tr key={p[0]}>
                  <td>{fmtTime(p[0], state.simulatedClock)}</td>
                  <td className="num">{fmtVal(p[1])}</td>
                  <td className="num">{p[2] < VIGIL_GOOD_SQI ? `${p[2].toFixed(1)} low` : p[2].toFixed(1)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SettingSignal({ sig, state }: { sig: VigilSignalState; state: Ready }) {
  return (
    <div className="sig">
      <div className="sig-head">
        <span className="sig-label">{sig.label}</span>
      </div>
      <div className="sig-compact">
        <span className="val">{fmtVal(sig.value)}</span>
        <span className="unit">{sig.unit}</span>
        <span className="note">
          setting, unchanged for {fmtDur(state.now - sig.changedAt)} · updated {fmtAgo(sig.age)}
        </span>
      </div>
    </div>
  );
}

function LabSignal({ sig, state }: { sig: VigilSignalState; state: Ready }) {
  const rows = sig.points.slice(0, -1).slice(-5).reverse();
  return (
    <div className="sig">
      <div className="sig-head">
        <span className="sig-label">{sig.label}</span>
      </div>
      <div className="sig-compact">
        <span className="val">{fmtVal(sig.value)}</span>
        <span className="unit">{sig.unit}</span>
        <span className="note">
          resulted {fmtTime(sig.t, state.simulatedClock)} ({fmtAgo(sig.age)})
        </span>
      </div>
      {rows.length > 0 && (
        <table className="vals">
          <thead>
            <tr>
              <th>Earlier results</th>
              <th className="num">{sig.unit}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p[0]}>
                <td>{fmtTime(p[0], state.simulatedClock)}</td>
                <td className="num">{fmtVal(p[1])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
