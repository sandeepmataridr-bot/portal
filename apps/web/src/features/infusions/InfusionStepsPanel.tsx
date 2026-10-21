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
import { VerifyDispenseModal } from './VerifyDispenseModal';
import { ReasonActionModal } from './ReasonActionModal';
import { OverrideModal } from './OverrideModal';

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

type StepModal =
  | { kind: 'verify'; step: InfusionStep }
  | { kind: 'reject'; step: InfusionStep }
  | { kind: 'cancel'; step: InfusionStep }
  | { kind: 'override'; step: InfusionStep }
  | null;

function StepActions({
  step,
  patientId,
  onOpenModal,
}: {
  step: InfusionStep;
  patientId: string;
  onOpenModal: (modal: StepModal) => void;
}) {
  const confirmHighAlert = useConfirmHighAlert(patientId);
  const start = useStartStep(patientId);
  const pause = usePauseStep(patientId);
  const resume = useResumeStep(patientId);
  const complete = useCompleteStep(patientId);

  // Override is the admin/doctor escape hatch — available from any
  // non-terminal, already-past-authoring state, not gated to one status.
  const canOverride = ['READY', 'RUNNING', 'PAUSED'].includes(step.status);
  const canReject = ['PENDING_PHARMACY_VERIFICATION', 'PHARMACY_VERIFIED', 'PENDING_SECOND_CONFIRMATION'].includes(step.status);
  const canCancel = ['DRAFT', 'PENDING_PHARMACY_VERIFICATION', 'PHARMACY_VERIFIED', 'PENDING_SECOND_CONFIRMATION', 'READY'].includes(
    step.status,
  );

  const rejectCancelButtons = (
    <>
      {canReject && (
        <button type="button" className="btn-danger" onClick={() => onOpenModal({ kind: 'reject', step })}>
          🚫 Reject
        </button>
      )}
      {canCancel && (
        <button type="button" className="btn-secondary" onClick={() => onOpenModal({ kind: 'cancel', step })}>
          ✖ Cancel
        </button>
      )}
      {canOverride && (
        <button type="button" className="btn-warning" onClick={() => onOpenModal({ kind: 'override', step })}>
          ⚠️ Override
        </button>
      )}
    </>
  );

  switch (step.status) {
    case 'PENDING_PHARMACY_VERIFICATION':
      return (
        <div className="inline-buttons">
          <button type="button" className="btn-primary" onClick={() => onOpenModal({ kind: 'verify', step })}>
            🧪 Verify
          </button>
          {rejectCancelButtons}
        </div>
      );
    case 'PENDING_SECOND_CONFIRMATION':
      return (
        <div className="inline-buttons">
          <button type="button" className="btn-warning" onClick={() => confirmHighAlert.mutate(step.id)} disabled={confirmHighAlert.isPending}>
            ⚠️ Confirm High-Alert
          </button>
          {rejectCancelButtons}
        </div>
      );
    case 'READY':
      return (
        <div className="inline-buttons">
          <button type="button" className="btn-start" onClick={() => start.mutate(step.id)} disabled={start.isPending}>
            ▶ Start
          </button>
          {rejectCancelButtons}
        </div>
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
          {rejectCancelButtons}
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
          {rejectCancelButtons}
        </div>
      );
    default:
      return null;
  }
}

export function InfusionStepsPanel({ patientId, machineId }: { patientId: string; machineId: string | null }) {
  const [showCreateOrder, setShowCreateOrder] = useState(false);
  const [stepModal, setStepModal] = useState<StepModal>(null);
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
                  <StepActions step={step} patientId={patientId} onOpenModal={setStepModal} />
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

      {stepModal?.kind === 'verify' && (
        <VerifyDispenseModal step={stepModal.step} patientId={patientId} onClose={() => setStepModal(null)} />
      )}
      {(stepModal?.kind === 'reject' || stepModal?.kind === 'cancel') && (
        <ReasonActionModal step={stepModal.step} patientId={patientId} action={stepModal.kind} onClose={() => setStepModal(null)} />
      )}
      {stepModal?.kind === 'override' && (
        <OverrideModal step={stepModal.step} patientId={patientId} onClose={() => setStepModal(null)} />
      )}
    </div>
  );
}
