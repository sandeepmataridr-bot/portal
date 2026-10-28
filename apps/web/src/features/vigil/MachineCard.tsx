import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  VIGIL_GOOD_SQI,
  VIGIL_STALE_S,
  type VigilMachineState,
  type VigilSignalState,
} from '@infusion/shared-types';
import { GAP_S, MARK, PATIENT, fmtAgo, fmtDur, fmtFlag, fmtSig, fmtTime, fmtUnit } from './format';
import { MachineAlarms, MachineLog } from './MachineEvents';
import { LIMIT_ROWS, signalGroup } from './sections';
import { LineChart, type AlertBand } from './LineChart';
import { alertBands, errorText, post, type Ready } from './actions';

/**
 * One Vigil machine (ECMO console, EBOO, patient monitor) with its live
 * signals, as the central station and the patient monitor page show it.
 * Needs the central station styles (central-station.css, scope .vigil-cs).
 */

const STATUS_TEXT: Record<VigilMachineState['status'], string> = {
  ok: 'Receiving',
  waiting: 'Waiting for data',
  no_data: 'No data',
  unconfirmed: 'Association not confirmed',
  unassociated: 'Not associated',
};

/** linkPatient: the machine's name opens its screen, the patient monitor page on its tab (off on that page itself). */
export function MachineCard({ m, state, linkPatient = true }: { m: VigilMachineState; state: Ready; linkPatient?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bands = m.encounterId ? alertBands(state, m.encounterId) : [];
  // The machine's alarm limits go in one table; every other signal under its HMI section heading.
  const limits = new Map(m.signals.filter((s) => s.code.startsWith('LIMIT_')).map((s) => [s.code, s]));
  const shown = m.signals.filter((s) => !s.code.startsWith('LIMIT_'));
  const grouped = new Set(shown.map((s) => signalGroup(s.code))).size > 1;
  // ECMO and EBOO consoles report their own alarms and logs.
  const reportsEvents = !!m.machineId && (m.kind === 'ECMO console' || m.kind === 'EBOO');
  // Silent for longer than the stale limit, whatever the association state
  // (an unconfirmed monitor that stops sending must still look stopped).
  const silent = m.status === 'no_data' || (m.status !== 'waiting' && m.age != null && m.age > VIGIL_STALE_S);
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
    <article className={`machine${silent ? ' is-nodata' : ''}`} data-alert={m.alertPriority ?? ''} aria-label={`Machine ${m.deviceId}`}>
      <div className="m-head">
        {linkPatient && m.encounterId && m.machineId ? (
          <Link
            className="m-open"
            to={`/patients/${encodeURIComponent(m.encounterId)}/monitor?tab=${encodeURIComponent(m.machineId)}`}
            title="Open this machine's screen"
          >
            <MachineTitle m={m} open />
          </Link>
        ) : (
          <div>
            <MachineTitle m={m} />
          </div>
        )}
        <span className={`status ${m.status}`}>
          {silent && m.age != null ? `No live data for ${fmtDur(m.age)}` : STATUS_TEXT[m.status]}
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
      {reportsEvents && <MachineAlarms machineId={m.machineId!} />}
      {m.status === 'unconfirmed' && m.associationId && (
        <div className="confirm-box">
          <span>Check at the bedside that this device is on this patient before rules start running.</span>
          <button className="btn" type="button" disabled={busy} onClick={() => void confirm()}>
            Confirm association
          </button>
          {error && <span className="form-error">{error}</span>}
        </div>
      )}
      <div className="m-signals">
        {shown.map((sig, i) => (
          <Fragment key={sig.code}>
            {grouped && (i === 0 || signalGroup(shown[i - 1].code) !== signalGroup(sig.code)) && (
              <div className="m-section">{signalGroup(sig.code)}</div>
            )}
            {sig.kind === 'numeric' ? (
              <NumericSignal sig={sig} stale={silent} bands={bands} state={state} />
            ) : sig.kind === 'lab' ? (
              <LabSignal sig={sig} state={state} />
            ) : sig.kind === 'status' ? (
              <StatusSignal sig={sig} stale={silent} state={state} />
            ) : (
              <SettingSignal sig={sig} state={state} />
            )}
          </Fragment>
        ))}
        {limits.size > 0 && <LimitsTable limits={limits} />}
            </div>
      {reportsEvents && <MachineLog machineId={m.machineId!} />}
    </article>
  );
}

/** The machine's name and kind; on the central station both open its screen (`open` adds the hint). */
function MachineTitle({ m, open = false }: { m: VigilMachineState; open?: boolean }) {
  return (
    <>
      <h3>
        {m.deviceId}
        {open && (
          <>
            {' '}
            <span aria-hidden="true">›</span>
            <span className="m-open-hint">Details</span>
          </>
        )}
      </h3>
      <div className="m-kind">
        {m.kind} · {m.driver}
        {m.unmapped ? ` · ${m.unmapped} unmapped values` : ''}
        {m.hiddenSignals ? ` · ${m.hiddenSignals} value${m.hiddenSignals === 1 ? '' : 's'} hidden by the superuser` : ''}
      </div>
    </>
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
          <span className="val">{fmtSig(sig, sig.value)}</span>
          <span className="unit">{fmtUnit(sig.unit)}</span>
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
        <div className="vals-scroll">
        <table className="vals">
          <thead>
            <tr>
              <th>Time</th>
              <th className="num">{fmtUnit(sig.unit)}</th>
              <th className="num">Quality</th>
            </tr>
          </thead>
          <tbody>
            {sig.points
              .slice()
              .reverse()
              .map((p, i, rows) => {
                const older = rows[i + 1];
                return (
                  <Fragment key={p[0]}>
                    <tr>
                      <td>{fmtTime(p[0], state.simulatedClock)}</td>
                      <td className="num">{fmtSig(sig, p[1])}</td>
                      <td className="num">{p[2] < VIGIL_GOOD_SQI ? `${p[2].toFixed(1)} low` : p[2].toFixed(1)}</td>
                    </tr>
                    {older && p[0] - older[0] > GAP_S && (
                      <tr className="gap-row">
                        <td colSpan={3}>— no data for {fmtDur(p[0] - older[0])} —</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

/** A device-reported state or alarm flag: OK / ALARM, and how long it has been so. */
function StatusSignal({ sig, stale, state }: { sig: VigilSignalState; stale: boolean; state: Ready }) {
  const active = sig.value >= 0.5;
  return (
    <div className={`sig${stale ? ' is-old' : ''}`}>
      <div className="sig-head">
        <span className="sig-label">{sig.label}</span>
      </div>
      <div className="sig-compact">
        <span className={`flag ${active ? 'is-alarm' : 'is-ok'}`}>{fmtFlag(sig.value, sig.kind)}</span>
        <span className="note">
          {active ? 'active' : 'normal'} for {fmtDur(state.now - sig.changedAt)} · updated {fmtAgo(sig.age)}
        </span>
      </div>
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
        <span className="val">{fmtSig(sig, sig.value)}</span>
        <span className="unit">{fmtUnit(sig.unit)}</span>
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
        <span className="val">{fmtSig(sig, sig.value)}</span>
        <span className="unit">{fmtUnit(sig.unit)}</span>
        <span className="note">
          resulted {fmtTime(sig.t, state.simulatedClock)} ({fmtAgo(sig.age)})
        </span>
      </div>
      {rows.length > 0 && (
        <table className="vals">
          <thead>
            <tr>
              <th>Earlier results</th>
              <th className="num">{fmtUnit(sig.unit)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p[0]}>
                <td>{fmtTime(p[0], state.simulatedClock)}</td>
                <td className="num">{fmtSig(sig, p[1])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** The machine's own alarm limits (set on the machine; shown only, never changed from here). */
function LimitsTable({ limits }: { limits: Map<string, VigilSignalState> }) {
  const cell = (code: string | null) => {
    const sig = code ? limits.get(code) : undefined;
    return sig ? `${fmtSig(sig, sig.value)} ${fmtUnit(sig.unit)}`.trim() : '—';
  };
  return (
    <div className="sig">
      <div className="m-section">
        Alarm limits <span className="m-section-note">set on the machine</span>
      </div>
      <table className="vals limits">
        <thead>
          <tr>
            <th>Parameter</th>
            <th className="num">Low</th>
            <th className="num">High</th>
          </tr>
        </thead>
        <tbody>
          {LIMIT_ROWS.filter(([, lo, hi]) => (lo && limits.has(lo)) || (hi && limits.has(hi))).map(([label, lo, hi]) => (
            <tr key={label}>
              <td>{label}</td>
              <td className="num">{cell(lo)}</td>
              <td className="num">{cell(hi)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
