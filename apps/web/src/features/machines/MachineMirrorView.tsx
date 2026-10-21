import { useState } from 'react';
import type { InfusionCommandType } from '@infusion/shared-types';
import { Modal } from '../../components/Modal';
import { useAuth } from '../../auth/AuthContext';
import { useLiveStatus } from '../infusions/api';
import { usePatients } from '../patients/api';
import { ApiError } from '../../lib/api';
import { useFleetStatus, useMachineCommands, useSendMachineCommand } from './api';

function formatMinutesAsSeconds(min: number) {
  return `${Math.round(min * 60)} Sec`;
}

function formatRemainingTime(remainingVolumeMl: number, flowRateMlPerH: number) {
  if (flowRateMlPerH <= 0) return '— Min';
  return `${Math.round((remainingVolumeMl / flowRateMlPerH) * 60)} Min`;
}

/**
 * Faithful visual replica of the real machine's running screen — read
 * directly from InfusionApp2's activity_infusion_monitor.xml (flow-rate
 * hero number + pump icon, a "mode" card, a "status" card with the 5-stat
 * row), not guessed. Any role that can reach this sees live telemetry;
 * the pause/resume/stop/flow-rate-adjust controls below are superuser-only
 * (plan § "Super-user remote commands") — the one deliberate, narrow
 * exception to "the machine always decides."
 */
export function MachineMirrorView({ machineId, machineCode, onClose }: { machineId: string; machineCode: string; onClose: () => void }) {
  const { user } = useAuth();
  const isSuperuser = user?.role === 'superuser';
  const { data: status } = useLiveStatus(machineId);
  const { data: patients } = usePatients('');
  const { data: commands } = useMachineCommands(isSuperuser ? machineId : null);
  // Reads the same fleet-status cache the table behind this modal uses,
  // rather than a snapshot captured when "View Live" was clicked — the
  // realtime client (lib/realtime.ts) invalidates this cache immediately on
  // `machine.status_changed`, so this badge/gate can't go stale for up to
  // 15s (the fleet table's own poll interval) the way a static prop would.
  const { data: fleet } = useFleetStatus();
  const machine = fleet?.machines.find((m) => m.id === machineId);
  const isOnline = machine?.status === 'online';

  const patient = status ? patients?.find((p) => p.id === status.patientId) : undefined;
  const [pendingCommand, setPendingCommand] = useState<{ commandType: InfusionCommandType; flowRateMlPerH?: number } | null>(null);
  const [flowRateInput, setFlowRateInput] = useState('');

  return (
    <Modal title={`📟 ${machineCode} — Live Mirror`} onClose={onClose} wide>
      <div className="mirror-view">
        <div className="mirror-view__header">
          <span className={`badge ${isOnline ? 'badge-yes' : 'badge-no'}`}>{isOnline ? '🟢 Online' : '⚪ Offline'}</span>
          {!status && <span className="form-hint">No live telemetry reported for this machine yet.</span>}
        </div>

        {status && (
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
                <div className="mirror-view__row">🧑‍⚕️ Patient Name : {patient?.fullName ?? status.patientId}</div>
                <div className="mirror-view__row">🏷️ IP no : {patient?.ipNumber ?? '—'}</div>
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
        )}

        {isSuperuser && (
          <div className="info-card mirror-view__controls">
            <h4 className="form-section-title">🎛️ Remote Control (superuser only)</h4>
            {!isOnline && <p className="form-hint">Machine is offline — commands are refused, never queued for later.</p>}
            <div className="toolbar">
              <button type="button" className="btn-secondary" disabled={!isOnline} onClick={() => setPendingCommand({ commandType: 'PAUSE' })}>
                ⏸️ Pause
              </button>
              <button type="button" className="btn-secondary" disabled={!isOnline} onClick={() => setPendingCommand({ commandType: 'RESUME' })}>
                ▶️ Resume
              </button>
              <button type="button" className="btn-danger" disabled={!isOnline} onClick={() => setPendingCommand({ commandType: 'STOP' })}>
                ⏹️ Stop
              </button>
            </div>
            <div className="form-row">
              <label>
                Adjust Flow Rate (mL/h)
                <input type="number" min="0" step="0.1" value={flowRateInput} onChange={(e) => setFlowRateInput(e.target.value)} />
              </label>
              <button
                type="button"
                className="btn-primary"
                disabled={!isOnline || !flowRateInput}
                onClick={() => setPendingCommand({ commandType: 'ADJUST_FLOW_RATE', flowRateMlPerH: Number(flowRateInput) })}
              >
                Apply Rate
              </button>
            </div>

            {commands && commands.length > 0 && (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Command</th>
                    <th>Issued By</th>
                    <th>Status</th>
                    <th>At</th>
                  </tr>
                </thead>
                <tbody>
                  {commands.slice(0, 5).map((c) => (
                    <tr key={c.id}>
                      <td>{c.commandType}</td>
                      <td>{c.issuedByLoginId}</td>
                      <td>
                        <span className={`badge ${c.status === 'ACKNOWLEDGED' ? 'badge-yes' : c.status === 'FAILED' ? 'badge-no' : ''}`}>
                          {c.status}
                        </span>
                      </td>
                      <td>{new Date(c.issuedAt).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {pendingCommand && (
        <ConfirmCommandModal
          machineId={machineId}
          machineCode={machineCode}
          commandType={pendingCommand.commandType}
          flowRateMlPerH={pendingCommand.flowRateMlPerH}
          onClose={() => setPendingCommand(null)}
          onSent={() => {
            setPendingCommand(null);
            setFlowRateInput('');
          }}
        />
      )}
    </Modal>
  );
}

const COMMAND_LABEL: Record<InfusionCommandType, string> = {
  PAUSE: 'Pause',
  RESUME: 'Resume',
  STOP: 'Stop',
  ADJUST_FLOW_RATE: 'Adjust Flow Rate',
};

/**
 * Password re-confirmation gate — reuses the account's own login password,
 * not a new mechanism, and travels with the command request itself (plan §
 * "Super-user remote commands": "makes an accidental click structurally
 * impossible, not just unlikely").
 */
function ConfirmCommandModal({
  machineId,
  machineCode,
  commandType,
  flowRateMlPerH,
  onClose,
  onSent,
}: {
  machineId: string;
  machineCode: string;
  commandType: InfusionCommandType;
  flowRateMlPerH?: number;
  onClose: () => void;
  onSent: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = useSendMachineCommand(machineId);

  const confirm = async () => {
    setError(null);
    try {
      await send.mutateAsync({ commandType, flowRateMlPerH, password });
      onSent();
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.body.violations)) {
        setError((err.body.violations as string[]).join('; '));
      } else {
        setError((err as Error).message);
      }
    }
  };

  return (
    <Modal title={`🔒 Confirm: ${COMMAND_LABEL[commandType]}`} onClose={onClose}>
      <div className="patient-form">
        <p className="form-hint">
          This sends a real, immediate command to <b>{machineCode}</b>
          {commandType === 'ADJUST_FLOW_RATE' ? ` (new rate: ${flowRateMlPerH} mL/h)` : ''}. Re-enter your password to confirm.
        </p>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </label>
        {error && <p className="form-error">❌ {error}</p>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn-danger" onClick={confirm} disabled={send.isPending || !password}>
          {send.isPending ? 'Sending…' : `Confirm ${COMMAND_LABEL[commandType]}`}
        </button>
      </div>
    </Modal>
  );
}
