import { useMemo, useState } from 'react';
import { PAYMENT_METHODS } from '@infusion/shared-types';
import { Modal } from '../../components/Modal';
import { usePatients } from '../patients/api';
import { useMachines } from '../machines/api';
import { useMedicines, useStockOut } from './api';

const GST_RATE = 0.18;

export function StockOutModal({ onClose }: { onClose: () => void }) {
  const { data: medicines } = useMedicines();
  const { data: patients } = usePatients('');
  const { data: machines } = useMachines();
  const stockOut = useStockOut();

  const [form, setForm] = useState({
    medicineId: '',
    quantity: '',
    patientSelection: '', // 'damaged' or a patient id
    machineId: '',
    paymentMethod: '',
    transactionRef: '',
    remarks: '',
  });
  const [error, setError] = useState<string | null>(null);

  const isDamaged = form.patientSelection === 'damaged';
  const selectedPatient = patients?.find((p) => p.id === form.patientSelection);
  const medicine = medicines?.find((m) => m.id === form.medicineId);

  const { subtotal, gst, total } = useMemo(() => {
    const qty = Number(form.quantity) || 0;
    const price = medicine?.pricePerUnit ?? 0;
    const sub = qty * price;
    return { subtotal: sub, gst: sub * GST_RATE, total: sub * (1 + GST_RATE) };
  }, [form.quantity, medicine]);

  const insuranceMessage = () => {
    if (isDamaged) return { text: '⚠️ Damaged/Expiry – no patient or machine', tone: 'muted' };
    if (!selectedPatient) return null;
    const status = selectedPatient.claimStatus;
    if (!status) return { text: 'No insurance applied', tone: 'muted' };
    if (status === 'approved') return { text: '✅ Insurance Accepted', tone: 'success' };
    if (status === 'rejected') return { text: '❌ Insurance Rejected', tone: 'danger' };
    if (status === 'partially_approved') return { text: '⚠️ Partially Approved', tone: 'warning' };
    return { text: `📄 Status: ${status}`, tone: 'muted' };
  };
  const insuranceInfo = insuranceMessage();

  const submit = async () => {
    if (!Number(form.quantity)) return setError('Valid positive integer required');
    if (!form.patientSelection) return setError('Please select a patient or Damaged/Expiry');
    if (!isDamaged && !form.paymentMethod) return setError('Please select a payment method');
    if (form.paymentMethod === 'UPI/Card/Netbanking' && !form.transactionRef) return setError('Transaction ID is required for digital payments');
    if (form.paymentMethod === 'Insurance' && isDamaged) return setError('Insurance payment cannot be used for Damaged/Expiry.');
    if (form.paymentMethod === 'Insurance' && selectedPatient?.claimStatus !== 'approved') {
      return setError("Insurance payment is only allowed if the patient's claim is Approved.");
    }
    setError(null);

    try {
      await stockOut.mutateAsync({
        medicineId: form.medicineId,
        quantity: Number(form.quantity),
        isDamaged,
        patientId: isDamaged ? undefined : form.patientSelection,
        machineId: form.machineId || undefined,
        paymentMethod: isDamaged ? undefined : (form.paymentMethod as (typeof PAYMENT_METHODS)[number]),
        transactionRef: form.transactionRef || undefined,
        remarks: form.remarks || undefined,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title="Stock Out" onClose={onClose}>
      <div className="patient-form">
        <label>
          Medicine
          <select value={form.medicineId} onChange={(e) => setForm({ ...form, medicineId: e.target.value })}>
            <option value="">-- Select --</option>
            {medicines?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.stockQty} available)
              </option>
            ))}
          </select>
        </label>
        <label>
          Quantity *
          <input type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
        </label>
        <label>
          Patient / Damaged *
          <select value={form.patientSelection} onChange={(e) => setForm({ ...form, patientSelection: e.target.value, machineId: '' })}>
            <option value="">-- Select --</option>
            <option value="damaged">🚫 Damaged/Expiry</option>
            {patients
              ?.filter((p) => !p.discharged)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName} ({p.ipNumber})
                </option>
              ))}
          </select>
        </label>
        {insuranceInfo && <p className={`stockout-insurance stockout-insurance--${insuranceInfo.tone}`}>{insuranceInfo.text}</p>}

        <label>
          Machine ID
          <select value={form.machineId} disabled={isDamaged} onChange={(e) => setForm({ ...form, machineId: e.target.value })}>
            <option value="">-- None --</option>
            {machines?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.machineCode}
              </option>
            ))}
          </select>
        </label>

        <hr />
        <div className="form-row form-row--4">
          <label>
            Subtotal (₹) (auto)
            <input type="text" readOnly value={subtotal.toFixed(2)} />
          </label>
          <label>
            GST (₹) (18%)
            <input type="text" readOnly value={gst.toFixed(2)} />
          </label>
          <label>
            Total Amount (₹) *
            <input type="text" readOnly value={total.toFixed(2)} />
          </label>
          <label>
            Payment Method *
            <select value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })} disabled={isDamaged}>
              <option value="">-- Select --</option>
              {PAYMENT_METHODS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>

        {form.paymentMethod === 'UPI/Card/Netbanking' && (
          <label>
            Transaction ID *
            <input value={form.transactionRef} onChange={(e) => setForm({ ...form, transactionRef: e.target.value })} />
          </label>
        )}

        <label>
          Remarks
          <textarea rows={2} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
        </label>

        {error && <p className="form-error">❌ {error}</p>}

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-warning" onClick={submit} disabled={stockOut.isPending}>
            Remove Stock
          </button>
        </div>
      </div>
    </Modal>
  );
}
