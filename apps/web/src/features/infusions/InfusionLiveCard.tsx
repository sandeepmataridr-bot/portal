import type { LiveStatus } from './api';

function formatMinutesAsSeconds(min: number) {
  return `${Math.round(min * 60)} Sec`;
}

function formatRemainingTime(remainingVolumeMl: number, flowRateMlPerH: number) {
  if (flowRateMlPerH <= 0) return '— Min';
  return `${Math.round((remainingVolumeMl / flowRateMlPerH) * 60)} Min`;
}

/**
 * The infusion pump's running screen, read-only: the flow-rate hero number
 * with the "mode" and "status" cards, as InfusionApp2's
 * activity_infusion_monitor.xml lays them out. Used by the admin/superuser
 * live mirror (with its remote controls) and the patient monitor page.
 * patientName/ipNumber are left out on the patient's own page.
 */
export function InfusionLiveCard({ status, patientName, ipNumber }: { status: LiveStatus; patientName?: string; ipNumber?: string }) {
  return (
    <div className="mirror-view__body">
      <div className="mirror-view__flow">
        <p className="mirror-view__flow-unit">mL/h</p>
        <p className="mirror-view__flow-label">Flow Rate</p>
        <p className="mirror-view__flow-value">{status.flowRateMlPerH}</p>
        <p className="mirror-view__pump-icon">💧</p>
      </div>

      <div className="mirror-view__cards">
        <div className="info-card mirror-view__mode-card">
          <p>
            <b>Working Mode:</b> <span className="mirror-view__accent">{status.workingMode ?? '—'}</span>
          </p>
          {patientName !== undefined && <div className="mirror-view__row">🧑‍⚕️ Patient Name : {patientName}</div>}
          {ipNumber !== undefined && <div className="mirror-view__row">🏷️ IP no : {ipNumber}</div>}
          <div className="mirror-view__row">💉 Dispensing : {status.pumpState === 'RUNNING' ? 'Active' : status.pumpState}</div>
          <div className="mirror-view__row">💊 Current Drug : {status.currentMedicineName ?? 'None'}</div>
        </div>

        <div className="info-card mirror-view__status-card">
          <p>
            <b>Working Status:</b> <span className="mirror-view__accent">{status.workingStatusRaw ?? status.pumpState}</span>
          </p>
          <div className="detail-grid">
            <div>
              <b>Disp. Volume</b>
              <p>{status.dispensedVolumeMl} mL</p>
            </div>
            <div>
              <b>Disp. Time</b>
              <p>{formatMinutesAsSeconds(status.infusedTimeMin)}</p>
            </div>
            <div>
              <b>Remaining vol</b>
              <p>{status.remainingVolumeMl} mL</p>
            </div>
            <div>
              <b>Rem. Time</b>
              <p>{formatRemainingTime(status.remainingVolumeMl, status.flowRateMlPerH)}</p>
            </div>
            <div>
              <b>Pause time</b>
              <p>{status.pauseTimeSec ?? 0} Sec</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
