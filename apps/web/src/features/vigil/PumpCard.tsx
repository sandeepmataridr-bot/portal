import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MACHINE_SENDING_WINDOW_S } from '@infusion/shared-types';
import type { LiveStatus } from '../infusions/api';
import { PATIENT, fmtAgo, fmtDur } from './format';

/**
 * An infusion pump on the patient monitor page, drawn like the Vigil machine
 * cards beside it (central-station.css, scope .vigil-cs) so every machine on
 * the page reads the same way. Its values come from the pump's live status
 * (POST /sync/push), not from Vigil. The pump's own screen layout stays in
 * InfusionLiveCard for the admin live mirror. `patient` (central station
 * only) adds the patient line and makes the pump's name open its screen.
 */
export function PumpCard({
  code,
  status,
  patient,
  machineId,
}: {
  code: string;
  status: LiveStatus | null | undefined;
  patient?: { id: string; label: string | null };
  /** With `patient`: the name opens this pump's tab on the patient monitor page. */
  machineId?: string;
}) {
  const now = useNow();
  // A pushed update without lastUpdateAt (older servers) counts as just received, never as "NaN ago".
  const updatedAt = status ? Date.parse(status.lastUpdateAt) : NaN;
  const age = status ? (Number.isFinite(updatedAt) ? Math.max(0, (now - updatedAt) / 1000) : 0) : null;
  const silent = age !== null && age > MACHINE_SENDING_WINDOW_S;
  const running = status?.pumpState === 'RUNNING';
  const remainingMin = status && status.flowRateMlPerH > 0 ? (status.remainingVolumeMl / status.flowRateMlPerH) * 60 : null;
  return (
    <article className={`machine${silent ? ' is-nodata' : ''}`} aria-label={`Machine ${code}`}>
      <div className="m-head">
        {patient && machineId ? (
          <Link
            className="m-open"
            to={`/patients/${encodeURIComponent(patient.id)}/monitor?tab=${encodeURIComponent(machineId)}`}
            title="Open this machine's screen"
          >
            <h3>
              {code} <span aria-hidden="true">›</span>
              <span className="m-open-hint">Details</span>
            </h3>
            <div className="m-kind">Infusion pump · sync channel</div>
          </Link>
        ) : (
          <div>
            <h3>{code}</h3>
            <div className="m-kind">Infusion pump · sync channel</div>
          </div>
        )}
        <span className={`status ${!status ? 'waiting' : silent ? 'no_data' : 'ok'}`}>
          {!status ? 'Waiting for data' : silent ? `No live data for ${fmtDur(age!)}` : 'Receiving'}
        </span>
      </div>
      {patient && (
        <p className="m-patient">
          Patient <b>{PATIENT(patient.label, patient.id)}</b> · INFUSION
        </p>
      )}
      {!status ? (
        <p className="m-patient">No live status reported by this pump yet.</p>
      ) : (
        <>
          <p className="m-patient">
            Drug <b>{status.currentMedicineName ?? 'None'}</b> · {status.workingStatusRaw ?? status.pumpState}
            {status.workingMode ? ` · ${status.workingMode}` : ''}
          </p>
          <div className="m-signals">
            <Value label="Flow rate" value={status.flowRateMlPerH} unit="mL/h" note={running ? 'dispensing' : status.pumpState.toLowerCase()} age={age!} big />
            <Value label="Dispensed volume" value={status.dispensedVolumeMl} unit="mL" note={`over ${fmtDur(status.infusedTimeMin * 60)}`} age={age!} />
            <Value
              label="Remaining volume"
              value={status.remainingVolumeMl}
              unit="mL"
              note={remainingMin !== null ? `about ${fmtDur(remainingMin * 60)} left` : 'not running'}
              age={age!}
            />
            {!!status.pauseTimeSec && <Value label="Paused" value={status.pauseTimeSec} unit="s" note="pause time" age={age!} />}
          </div>
        </>
      )}
    </article>
  );
}

function Value({ label, value, unit, note, age, big = false }: { label: string; value: number; unit: string; note: string; age: number; big?: boolean }) {
  return (
    <div className="sig">
      <div className="sig-head">
        <span className="sig-label">{label}</span>
      </div>
      <div className={big ? 'sig-value' : 'sig-compact'}>
        <span className="val">{Number.isInteger(value) ? value : value.toFixed(1)}</span>
        <span className="unit">{unit}</span>
        <span className={big ? 'sig-age' : 'note'}>
          {note} · updated {fmtAgo(age)}
        </span>
      </div>
    </div>
  );
}

/** Re-renders every second so "updated … ago" and the no-data state keep moving between polls. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
