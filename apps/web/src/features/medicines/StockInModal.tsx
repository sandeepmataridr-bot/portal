import { useState } from 'react';
import { STOCK_IN_SUPPLIERS } from '@infusion/shared-types';
import { Modal } from '../../components/Modal';
import { useMedicines, useStockIn } from './api';

export function StockInModal({ onClose }: { onClose: () => void }) {
  const { data: medicines } = useMedicines();
  const stockIn = useStockIn();
  const [form, setForm] = useState({ medicineId: '', quantity: '', unitCost: '', supplier: '', invoiceNo: '', remarks: '' });
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!Number(form.quantity)) return setError('Valid quantity required');
    if (!Number(form.unitCost)) return setError('Unit cost must be greater than 0');
    if (!form.supplier) return setError('Please select a supplier');
    setError(null);
    try {
      await stockIn.mutateAsync({
        medicineId: form.medicineId,
        quantity: Number(form.quantity),
        unitCost: Number(form.unitCost),
        supplier: form.supplier as (typeof STOCK_IN_SUPPLIERS)[number],
        invoiceNo: form.invoiceNo || undefined,
        remarks: form.remarks || undefined,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title="Stock In" onClose={onClose}>
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
        <div className="form-row form-row--4">
          <label>
            Quantity *
            <input type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          </label>
          <label>
            Unit Cost *
            <input type="number" value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value })} />
          </label>
          <label>
            Supplier *
            <select value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })}>
              <option value="">-- Select --</option>
              {STOCK_IN_SUPPLIERS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Invoice No.
            <input value={form.invoiceNo} onChange={(e) => setForm({ ...form, invoiceNo: e.target.value })} />
          </label>
        </div>
        <label>
          Remarks
          <textarea rows={2} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
        </label>
        {error && <p className="form-error">❌ {error}</p>}
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={submit} disabled={stockIn.isPending}>
            Add Stock
          </button>
        </div>
      </div>
    </Modal>
  );
}
