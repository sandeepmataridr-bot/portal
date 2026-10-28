import { useEffect, useSyncExternalStore } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MACHINE_TYPE_LABEL, isVigilMachineType, type MachineType, type VigilState } from '@infusion/shared-types';
import { AppShell } from '../../components/AppShell';
import { useAuth } from '../../auth/AuthContext';
import { DownloadPatientLog } from '../patients/DownloadPatientLog';
import { useLiveStatus } from '../infusions/api';
import { PumpCard } from '../vigil/PumpCard';
import { usePatient } from '../patients/api';
import { MARK, fmtWindow } from '../vigil/format';
import type { Ready } from '../vigil/actions';
import { MachineCard } from '../vigil/MachineCard';
import { OUT_PATIENT } from '../rooms/api';
import { getSnapshot, setWindow, start, subscribe } from '../vigil/store';
import '../vigil/central-station.css';

/**
 * Everything attached to one patient on one page: ECMO/EBOO consoles and
 * patient monitors (SpO₂, temperature, multi-parameter) with their live
 * Vigil signals, and infusion pumps with their running screen. Tabs: "All"
 * (every machine one after another) and one per machine; the chosen tab is
 * kept in the address (?tab=<machine id>), so a link opens the same view.
 */

interface AttachedMachine {
  machineId: string;
  code: string;
  type: string;
}

/** Display order: circuits first, then monitors, then pumps. */
const TYPE_ORDER: string[] = ['ECMO', 'EBOO', 'PATIENT_MONITOR', 'SPO2_MONITOR', 'TEMP_MONITOR', 'INFUSION_PUMP'];

function typeLabel(type: string): string {
  return MACHINE_TYPE_LABEL[type as MachineType] ?? type;
}

function useVigilState(): { state: Ready | null; window: number } {
  useEffect(() => start(), []);
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  const s: VigilState | null = snap.state;
  return { state: s && s.ready ? s : null, window: snap.window };
}

export function PatientMonitorPage() {
  const { patientId = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const { data: patient, isLoading, error } = usePatient(patientId);
  const { state, window: win } = useVigilState();

  const machines: AttachedMachine[] = (patient?.machineAssignments ?? [])
    .map((a) => ({ machineId: a.machineId, code: a.machine.machineCode, type: a.machine.machineType }))
    .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.code.localeCompare(b.code));
  const tab = params.get('tab') ?? 'all';
  const shown = tab === 'all' ? machines : machines.filter((m) => m.machineId === tab);
  const alerts = state?.alerts.filter((a) => a.encounter === patientId) ?? [];
  const hasVigil = machines.some((m) => isVigilMachineType(m.type));

  const title = patient ? `🩺 ${patient.fullName}${patient.ipNumber ? ` (${patient.ipNumber})` : ''}` : '🩺 Patient monitor';

  return (
    <AppShell title={title}>
      <div className="pm-bar">
        <button type="button" className="link-button" onClick={() => navigate(-1)}>
          ← Back
        </button>
        {patient && (
          <span className="pm-meta">
            {patient.room?.name ?? OUT_PATIENT} · 
            {machines.length} machine{machines.length === 1 ? '' : 's'} attached
            {patient.discharged ? ' · discharged' : ''}
          </span>
        )}
      </div>
      {patient && user?.role === 'superuser' && (
        <div className="download-log-row">
          <DownloadPatientLog patientId={patient.id} patientName={patient.fullName} />
        </div>
      )}

      {isLoading && <p className="form-hint">Loading…</p>}
      {error && <p className="form-error">Could not load this patient.</p>}

      {alerts.length > 0 && (
        <div className="pm-alerts" role="alert">
          {alerts.map((a) => (
            <div key={a.alertId} className={`pm-alert pm-alert--${a.priority.toLowerCase()}`}>
              <b>
                {MARK[a.priority]} {a.priority}
              </b>{' '}
              {a.explanation}
            </div>
          ))}
        </div>
      )}

      {patient && machines.length === 0 && (
        <div className="info-card">
          <p className="form-hint">No machines are attached to this patient.</p>
          {user?.role === 'admin' && <Link to="/admin">Assign a machine in the fleet</Link>}
        </div>
      )}

      {machines.length > 0 && (
        <>
          <div className="tabs pm-tabs" role="tablist" aria-label="Machines">
            <TabButton id="all" current={tab} onPick={(t) => setParams({ tab: t }, { replace: true })}>
              All
            </TabButton>
            {machines.map((m) => (
              <TabButton key={m.machineId} id={m.machineId} current={tab} onPick={(t) => setParams({ tab: t }, { replace: true })}>
                {typeLabel(m.type)} · {m.code}
              </TabButton>
            ))}
          </div>

          {hasVigil && state && (
            <div className="pm-window" role="radiogroup" aria-label="Chart time window">
              {state.windows.map((w) => (
                <button key={w} type="button" role="radio" aria-checked={w === win} onClick={() => setWindow(w)}>
                  {fmtWindow(w)}
                </button>
              ))}
            </div>
          )}

          <div className="pm-machines">
            {shown.map((m) =>
              isVigilMachineType(m.type) ? (
                <VigilMachine key={m.machineId} machine={m} state={state} />
              ) : m.type === 'INFUSION_PUMP' ? (
                <InfusionMachine key={m.machineId} machine={m} />
              ) : (
                <section key={m.machineId} className="info-card">
                  <h3 className="pm-machine-title">
                    {typeLabel(m.type)} · {m.code}
                  </h3>
                  <p className="form-hint">No live view for this machine type yet.</p>
                </section>
              ),
            )}
          </div>
        </>
      )}
    </AppShell>
  );
}

function TabButton({ id, current, onPick, children }: { id: string; current: string; onPick: (id: string) => void; children: React.ReactNode }) {
  const active = id === current;
  return (
    <button type="button" role="tab" aria-selected={active} className={`tab-button${active ? ' tab-button--active' : ''}`} onClick={() => onPick(id)}>
      {children}
    </button>
  );
}

function VigilMachine({ machine, state }: { machine: AttachedMachine; state: Ready | null }) {
  const m = state?.machines.find((x) => x.deviceId === machine.code);
  return (
    <section className="pm-machine" aria-label={`${typeLabel(machine.type)} ${machine.code}`}>
      <div className="vigil-cs is-embedded">
        {state && m ? (
          <div className="machines">
            <MachineCard m={m} state={state} linkPatient={false} />
          </div>
        ) : (
          <div className="info-card">
            <h3 className="pm-machine-title">
              {typeLabel(machine.type)} · {machine.code}
            </h3>
            <p className="form-hint">{state ? 'Waiting for data from this machine.' : 'Connecting to live monitoring…'}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function InfusionMachine({ machine }: { machine: AttachedMachine }) {
  const { data: status } = useLiveStatus(machine.machineId);
  return (
    <section className="pm-machine" aria-label={`Infusion pump ${machine.code}`}>
      <div className="vigil-cs is-embedded">
        <div className="machines">
          <PumpCard code={machine.code} status={status} />
        </div>
      </div>
    </section>
  );
}
