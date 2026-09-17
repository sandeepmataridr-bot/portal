import { useState } from 'react';
import type { InfusionStepInput } from '@infusion/shared-types';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { useMedicines } from '../medicines/api';
import { useCreateInfusionOrder, useSubmitOrder } from './api';

interface DraftStep {
  medicineId: string;
  plannedVolumeMl: string;
  plannedRateMlPerH: string;
  rackNo: string;
}

const emptyStep = (): DraftStep => ({ medicineId: '', plannedVolumeMl: '', plannedRateMlPerH: '', rackNo: '' });

export function CreateOrderModal({ patientId, machineId, onClose }: { patientId: string; machineId: string; onClose: () => void }) {
  const { data: medicines } = useMedicines();
  const [steps, setSteps] = useState<DraftStep[]>([emptyStep()]);
  const [clinicalNotes, setClinicalNotes] = useState('');
  const [violations, setViolations] = useState<string[]>([]);
  const createOrder = useCreateInfusionOrder();
  const submitOrder = useSubmitOrder(patientId);

  const activeMedicines = medicines?.filter((m) => m.status === 'ACTIVE') ?? [];

  const updateStep = (i: number, patch: Partial<DraftStep>) => {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  const addStep = () => setSteps((prev) => [...prev, emptyStep()]);
  const removeStep = (i: number) => setSteps((prev) => prev.filter((_, idx) => idx !== i));

  const submit = async () => {
    setViolations([]);
    const payload: InfusionStepInput[] = steps.map((s, idx) => ({
      stepNumber: idx + 1,
      medicineId: s.medicineId,
      plannedVolumeMl: Number(s.plannedVolumeMl),
      plannedRateMlPerH: Number(s.plannedRateMlPerH),
      rackNo: s.rackNo ? Number(s.rackNo) : undefined,
    }));

    try {
      const order = await createOrder.mutateAsync({ patientId, machineId, clinicalNotes: clinicalNotes || undefined, steps: payload });
      await submitOrder.mutateAsync(order.id);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.body.violations)) {
        setViolations(err.body.violations as string[]);
      } else {
        setViolations([(err as Error).message]);
      }
    }
  };

  return (
    <Modal title="New Infusion Order" onClose={onClose} wide>
      <div className="patient-form">
        <p className="form-hint">Each step is validated against the medicine's dosage/rate caps before the order can be created.</p>

        {steps.map((step, i) => (
          <div key={i} className="step-row">
            <span className="step-row__number">Step {i + 1}</span>
            <select value={step.medicineId} onChange={(e) => updateStep(i, { medicineId: e.target.value })}>
              <option value="">-- Medicine --</option>
              {activeMedicines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.concentration}) {m.highAlert ? '⚠️ High Alert' : ''}
                </option>
              ))}
            </select>
            <input
              type="number"
              placeholder="Volume (ml)"
              value={step.plannedVolumeMl}
              onChange={(e) => updateStep(i, { plannedVolumeMl: e.target.value })}
            />
            <input
              type="number"
              placeholder="Rate (ml/h)"
              value={step.plannedRateMlPerH}
              onChange={(e) => updateStep(i, { plannedRateMlPerH: e.target.value })}
            />
            <input type="number" placeholder="Rack" value={step.rackNo} onChange={(e) => updateStep(i, { rackNo: e.target.value })} />
            {steps.length > 1 && (
              <button type="button" className="btn-secondary" onClick={() => removeStep(i)}>
                ✖
              </button>
            )}
          </div>
        ))}

        <button type="button" className="btn-secondary" onClick={addStep}>
          ➕ Add Step
        </button>

        <label style={{ marginTop: 12 }}>
          Clinical Notes
          <textarea value={clinicalNotes} onChange={(e) => setClinicalNotes(e.target.value)} rows={2} />
        </label>

        {violations.length > 0 && (
          <div className="form-error">
            {violations.map((v, i) => (
              <p key={i}>❌ {v}</p>
            ))}
          </div>
        )}

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={submit} disabled={createOrder.isPending || submitOrder.isPending}>
            {createOrder.isPending || submitOrder.isPending ? 'Submitting…' : 'Create & Submit Order'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
