import { useState } from 'react';
import {
  usePatientOrders,
  useLiveStatus,
  useConfirmHighAlert,
  useStartStep,
  usePauseStep,
  useResumeStep,
  useCompleteStep,
  type InfusionStep,
} from './api';
import { CreateOrderModal } from './CreateOrderModal';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_PHARMACY_VERIFICATION: 'Awaiting Pharmacy Verification',
  PHARMACY_VERIFIED: 'Verified',
  PENDING_SECOND_CONFIRMATION: 'Awaiting High-Alert Confirmation',
  READY: 'Ready to Start',
  RUNNING: 'Running',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  OVERRIDDEN: 'Overridden',
};

function StepActions({ step, patientId }: { step: InfusionStep; patientId: string }) {
  const confirmHighAlert = useConfirmHighAlert(patientId);
  const start = useStartStep(patientId);
  const pause = usePauseStep(patientId);
  const resume = useResumeStep(patientId);
  const complete = useCompleteStep(patientId);

  switch (step.status) {
    case 'PENDING_SECOND_CONFIRMATION':
      return (
        <button type="button" className="btn-warning" onClick={() => confirmHighAlert.mutate(step.id)} disabled={confirmHighAlert.isPending}>
          ⚠️ Confirm High-Alert
        </button>
      );
    case 'READY':
      return (
        <button type="button" className="btn-start" onClick={() => start.mutate(step.id)} disabled={start.isPending}>
          ▶ Start
        </button>
      );
    case 'RUNNING':
      return (
        <div className="inline-buttons">
          <button type="button" className="btn-pause" onClick={() => pause.mutate(step.id)} disabled={pause.isPending}>
            ⏸ Pause
          </button>
          <button type="button" className="btn-primary" onClick={() => complete.mutate(step.id)} disabled={complete.isPending}>
            ✅ Complete
          </button>
        </div>
      );
    case 'PAUSED':
      return (
        <div className="inline-buttons">
          <button type="button" className="btn-start" onClick={() => resume.mutate(step.id)} disabled={resume.isPending}>
            ▶ Resume
          </button>
          <button type="button" className="btn-primary" onClick={() => complete.mutate(step.id)} disabled={complete.isPending}>
            ✅ Complete
          </button>
        </div>
      );
    default:
      return null;
  }
}

export function InfusionStepsPanel({ patientId, machineId }: { patientId: string; machineId: string | null }) {
  const [showCreateOrder, setShowCreateOrder] = useState(false);
  const { data: orders } = usePatientOrders(patientId);
  const { data: liveStatus } = useLiveStatus(machineId);

  return (
    <div className="info-card">
      <h4 className="form-section-title">🖥️ Infusion Orders</h4>

      {liveStatus && (
        <div className="metrics-row">
          <div className="metric-item">
            <div className="metric-value">{liveStatus.currentMedicineName ?? '—'}</div>
            <div className="metric-label">Current Medicine</div>
          </div>
          <div className="metric-item">
            <div className="metric-value">{liveStatus.remainingVolumeMl} ml</div>
            <div className="metric-label">Remaining</div>
          </div>
          <div className="metric-item">
            <div className="metric-value">{liveStatus.flowRateMlPerH} ml/h</div>
            <div className="metric-label">Flow Rate</div>
          </div>
          <div className="metric-item">
            <div className="metric-value">{liveStatus.pumpState}</div>
            <div className="metric-label">Pump Status</div>
          </div>
        </div>
      )}

      <button type="button" className="btn-primary" disabled={!machineId} onClick={() => setShowCreateOrder(true)}>
        ➕ New Infusion Order
      </button>
      {!machineId && <p className="form-hint">Tag a machine to this patient before creating an order.</p>}

      {orders?.map((order) => (
        <table key={order.id} className="data-table steps-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Medicine</th>
              <th>Volume (ml)</th>
              <th>Rate (ml/h)</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {order.steps.map((step) => (
              <tr key={step.id}>
                <td>{step.stepNumber}</td>
                <td>
                  {step.medicine.name} {step.medicine.highAlert ? '⚠️' : ''}
                </td>
                <td>{step.plannedVolumeMl}</td>
                <td>{step.plannedRateMlPerH}</td>
                <td>
                  <span className={`status-badge status-${step.status.toLowerCase()}`}>{STATUS_LABEL[step.status] ?? step.status}</span>
                </td>
                <td>
                  <StepActions step={step} patientId={patientId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      {orders?.length === 0 && <p className="timeline-empty">No infusion orders yet.</p>}

      {showCreateOrder && machineId && (
        <CreateOrderModal patientId={patientId} machineId={machineId} onClose={() => setShowCreateOrder(false)} />
      )}
    </div>
  );
}
