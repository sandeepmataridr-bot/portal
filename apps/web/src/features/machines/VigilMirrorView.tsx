import { useEffect, useSyncExternalStore } from 'react';
import { VIGIL_STALE_S, type VigilMachineState, type VigilSignalState } from '@infusion/shared-types';
import { Modal } from '../../components/Modal';
import { fmtAgo, fmtDur, fmtFlag, fmtUnit, fmtVal } from '../vigil/format';
import { getSnapshot, start, subscribe } from '../vigil/store';

/** The big number's icon, by the main signal. */
const ICON: Record<string, string> = {
  ECMO_BLOOD_FLOW: '🩸',
  VITAL_SPO2: '🫁',
  VITAL_TEMP: '🌡️',
  VITAL_HEART_RATE: '💓',
  VITAL_PULSE_RATE: '💓',
};

function brief(sig: VigilSignalState): string {
  if (sig.unit === 'flag') return fmtFlag(sig.value, sig.kind);
  const unit = fmtUnit(sig.unit);
  return `${fmtVal(sig.value)}${unit ? ` ${unit}` : ''}`;
}

/**
 * "View Live" for a monitoring machine (ECMO, EBOO, SpO2 / temperature /
 * multi-parameter monitor), laid out like the infusion pump's live mirror
 * (InfusionLiveCard): the main reading large, then the patient and every other
 * current value in brief. Values come from Vigil's live state, polled only
 * while this is open.
 */
export function VigilMirrorView({ machineCode, onClose }: { machineCode: string; onClose: () => void }) {
  useEffect(() => start(), []);
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  const state = snap.state && snap.state.ready ? snap.state : null;
  const m: VigilMachineState | undefined = state?.machines.find((x) => x.deviceId === machineCode);
  const silent = !!m && (m.status === 'no_data' || (m.status !== 'waiting' && m.age != null && m.age > VIGIL_STALE_S));
  const main = m?.signals.find((s) => s.kind === 'numeric') ?? m?.signals[0];
  const rest = m?.signals.filter((s) => s !== main) ?? [];

  return (
    <Modal title={`📟 ${machineCode} — Live Mirror`} onClose={onClose} wide>
      <div className="mirror-view">
        <div className="mirror-view__header">
          <span className={`badge ${m && !silent && m.status !== 'waiting' ? 'badge-yes' : 'badge-no'}`}>
            {!m || m.status === 'waiting'
              ? '⚪ Waiting for data'
              : silent
                ? `⚪ No live data${m.age != null ? ` for ${fmtDur(m.age)}` : ''}`
                : '🟢 Receiving'}
          </span>
          {!state && <span className="form-hint">Connecting to live monitoring…</span>}
          {state && !m && <span className="form-hint">Nothing received from this machine yet.</span>}
        </div>

        {m && main && (
          <div className="mirror-view__body">
            <div className="mirror-view__flow">
              <p className="mirror-view__flow-unit">{fmtUnit(main.unit) || ' '}</p>
              <p className="mirror-view__flow-label">{main.label}</p>
              <p className={`mirror-view__flow-value${silent ? ' mirror-view__flow-value--old' : ''}`}>
                {main.unit === 'flag' ? fmtFlag(main.value, main.kind) : fmtVal(main.value)}
              </p>
              <p className="mirror-view__pump-icon">{ICON[main.code] ?? '📈'}</p>
            </div>

            <div className="mirror-view__cards">
              <div className="info-card mirror-view__mode-card">
                <p>
                  <b>Machine:</b> <span className="mirror-view__accent">{m.kind}</span>
                </p>
                <div className="mirror-view__row">🧑‍⚕️ Patient : {m.patientLabel ?? (m.encounterId ? m.encounterId : 'Not tagged to a patient')}</div>
                {m.therapy && (
                  <div className="mirror-view__row">
                    🩺 Therapy : {m.therapy}
                    {m.confirmedBy ? ` · confirmed by ${m.confirmedBy}` : ' · not confirmed, rules paused'}
                  </div>
                )}
                <div className="mirror-view__row">🕒 Updated : {m.age != null ? fmtAgo(m.age) : '—'}</div>
              </div>

              <div className="info-card mirror-view__status-card">
                <p>
                  <b>Working Status:</b>{' '}
                  <span className={m.alertPriority ? 'mirror-view__alert' : 'mirror-view__accent'}>
                    {m.alertPriority ? `${m.alertPriority} alert` : silent ? 'No live data' : 'Normal'}
                  </span>
                </p>
                {rest.length > 0 && (
                  <div className="detail-grid">
                    {rest.map((s) => (
                      <div key={s.code}>
                        <b>{s.label}</b>
                        <p className={s.unit === 'flag' && s.kind === 'status' && s.value >= 0.5 ? 'mirror-view__alert' : undefined}>
                          {brief(s)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
