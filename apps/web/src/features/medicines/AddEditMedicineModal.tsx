import { useState } from 'react';
import type { UpsertMedicineInput } from '@infusion/shared-types';
import { Modal } from '../../components/Modal';
import { useCreateMedicine, useUpdateMedicine, type Medicine } from './api';

export function AddEditMedicineModal({ medicine, onClose }: { medicine?: Medicine; onClose: () => void }) {
  const create = useCreateMedicine();
  const update = useUpdateMedicine();
  const [form, setForm] = useState({
    medicineCode: medicine?.medicineCode ?? '',
    name: medicine?.name ?? '',
    genericName: medicine?.genericName ?? '',
    brand: medicine?.brand ?? '',
    category: medicine?.category ?? '',
    concentration: medicine?.concentration ?? '',
    manufacturer: medicine?.manufacturer ?? '',
    unitMl: medicine?.unitMl?.toString() ?? '',
    batchNo: medicine?.batchNo ?? '',
    expiryDate: medicine?.expiryDate?.slice(0, 10) ?? '',
    stockQty: medicine?.stockQty?.toString() ?? '0',
    pricePerUnit: medicine?.pricePerUnit?.toString() ?? '0',
    minStock: medicine?.minStock?.toString() ?? '0',
    reorderLevel: medicine?.reorderLevel?.toString() ?? '0',
    flushRequired: medicine?.flushRequired ?? false,
    flushVolumeMl: medicine?.flushVolumeMl?.toString() ?? '0',
    highAlert: medicine?.highAlert ?? false,
    status: medicine?.status ?? 'ACTIVE',
    maxFlowRateMlPerH: medicine?.maxFlowRateMlPerH?.toString() ?? '',
    maxSingleDoseMl: medicine?.maxSingleDoseMl?.toString() ?? '',
    absoluteMaxFlowRateMlPerH: medicine?.absoluteMaxFlowRateMlPerH?.toString() ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const input: UpsertMedicineInput = {
      medicineCode: form.medicineCode,
      name: form.name,
      genericName: form.genericName || undefined,
      brand: form.brand || undefined,
      category: form.category || undefined,
      concentration: form.concentration,
      manufacturer: form.manufacturer || undefined,
      unitMl: Number(form.unitMl),
      batchNo: form.batchNo || undefined,
      expiryDate: form.expiryDate || undefined,
      stockQty: Number(form.stockQty),
      pricePerUnit: Number(form.pricePerUnit),
      minStock: Number(form.minStock),
      reorderLevel: Number(form.reorderLevel),
      flushRequired: form.flushRequired,
      flushVolumeMl: Number(form.flushVolumeMl),
      highAlert: form.highAlert,
      status: form.status as 'ACTIVE' | 'INACTIVE',
      maxFlowRateMlPerH: form.maxFlowRateMlPerH ? Number(form.maxFlowRateMlPerH) : null,
      maxSingleDoseMl: form.maxSingleDoseMl ? Number(form.maxSingleDoseMl) : null,
      absoluteMaxFlowRateMlPerH: form.absoluteMaxFlowRateMlPerH ? Number(form.absoluteMaxFlowRateMlPerH) : null,
    };
    try {
      if (medicine) {
        await update.mutateAsync({ id: medicine.id, input });
      } else {
        await create.mutateAsync(input);
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title={medicine ? 'Edit Medicine' : 'Add Medicine'} onClose={onClose} wide>
      <div className="patient-form">
        <div className="form-row form-row--4">
          <label>
            Medicine ID *
            <input value={form.medicineCode} onChange={(e) => setForm({ ...form, medicineCode: e.target.value })} />
          </label>
          <label>
            Name *
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Quantity (ml) *
            <input value={form.unitMl} onChange={(e) => setForm({ ...form, unitMl: e.target.value })} placeholder="e.g. 500" />
          </label>
          <label>
            Generic Name
            <input value={form.genericName} onChange={(e) => setForm({ ...form, genericName: e.target.value })} />
          </label>
        </div>
        <div className="form-row form-row--4">
          <label>
            Brand
            <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
          </label>
          <label>
            Category
            <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </label>
          <label>
            Concentration *
            <input
              value={form.concentration}
              onChange={(e) => setForm({ ...form, concentration: e.target.value })}
              placeholder="e.g. 2.5 mg/ml, 10%"
            />
          </label>
          <label>
            Manufacturer
            <input value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} />
          </label>
        </div>
        <div className="form-row form-row--4">
          <label>
            Batch No.
            <input value={form.batchNo} onChange={(e) => setForm({ ...form, batchNo: e.target.value })} />
          </label>
          <label>
            Expiry Date
            <input type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} />
          </label>
          <label>
            Stock Qty *
            <input type="number" value={form.stockQty} onChange={(e) => setForm({ ...form, stockQty: e.target.value })} />
          </label>
          <label>
            Price per unit *
            <input type="number" value={form.pricePerUnit} onChange={(e) => setForm({ ...form, pricePerUnit: e.target.value })} />
          </label>
        </div>
        <div className="form-row form-row--4">
          <label>
            Min Stock
            <input type="number" value={form.minStock} onChange={(e) => setForm({ ...form, minStock: e.target.value })} />
          </label>
          <label>
            Reorder Level
            <input type="number" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} />
          </label>
          <label className="condition-pill">
            <input type="checkbox" checked={form.flushRequired} onChange={(e) => setForm({ ...form, flushRequired: e.target.checked })} />
            Flush Required
          </label>
          <label>
            Flush Volume
            <input type="number" value={form.flushVolumeMl} onChange={(e) => setForm({ ...form, flushVolumeMl: e.target.value })} />
          </label>
        </div>
        <div className="form-row form-row--4">
          <label className="condition-pill">
            <input type="checkbox" checked={form.highAlert} onChange={(e) => setForm({ ...form, highAlert: e.target.checked })} />
            ⚠️ High Alert
          </label>
          <label>
            Status
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'ACTIVE' | 'INACTIVE' })}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </label>
        </div>

        <h4 className="form-section-title">⚠️ Dosage / Rate Caps</h4>
        <div className="form-row form-row--4">
          <label>
            Max Flow Rate (ml/h)
            <input
              type="number"
              value={form.maxFlowRateMlPerH}
              onChange={(e) => setForm({ ...form, maxFlowRateMlPerH: e.target.value })}
              placeholder="No limit"
            />
          </label>
          <label>
            Max Single Dose (ml)
            <input
              type="number"
              value={form.maxSingleDoseMl}
              onChange={(e) => setForm({ ...form, maxSingleDoseMl: e.target.value })}
              placeholder="No limit"
            />
          </label>
          <label>
            Absolute Max Flow Rate (ml/h)
            <input
              type="number"
              value={form.absoluteMaxFlowRateMlPerH}
              onChange={(e) => setForm({ ...form, absoluteMaxFlowRateMlPerH: e.target.value })}
              placeholder="Never overridable"
            />
          </label>
        </div>

        {error && <p className="form-error">❌ {error}</p>}

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={submit} disabled={create.isPending || update.isPending}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
