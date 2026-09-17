import { useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { StatTile } from '../../components/StatTile';
import { MachineStatusTile } from '../../components/MachineStatusTile';
import { useMedicines, useMedicineDashboard, useTransactions, useMedicinesAudit } from '../../features/medicines/api';
import { AddEditMedicineModal } from '../../features/medicines/AddEditMedicineModal';
import { StockInModal } from '../../features/medicines/StockInModal';
import { StockOutModal } from '../../features/medicines/StockOutModal';
import { useMedicineRequests, useUpdateMedicineRequestStatus } from '../../features/medicine-requests/api';
import type { Medicine } from '../../features/medicines/api';

type Tab = 'inventory' | 'stockin' | 'stockout' | 'audit' | 'requests';

function rowTone(m: Medicine): string {
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86_400_000);
  const expiry = m.expiryDate ? new Date(m.expiryDate) : null;
  const classes: string[] = [];
  if (expiry && expiry < now) classes.push('row-expired');
  else if (expiry && expiry <= in30) classes.push('row-expiring-soon');
  if (m.status === 'ACTIVE' && m.stockQty <= m.reorderLevel) classes.push('row-low-stock');
  return classes.join(' ');
}

export function PharmacyDashboard() {
  const [tab, setTab] = useState<Tab>('inventory');
  const [modal, setModal] = useState<'add' | 'edit' | 'stockin' | 'stockout' | null>(null);
  const [editingMedicine, setEditingMedicine] = useState<Medicine | undefined>(undefined);
  const [search, setSearch] = useState('');

  const { data: dashboard } = useMedicineDashboard();
  const { data: medicines } = useMedicines();
  const { data: stockInTx } = useTransactions('STOCK_IN');
  const { data: stockOutTx } = useTransactions('STOCK_OUT');
  const { data: auditLogs } = useMedicinesAudit();
  const { data: requests } = useMedicineRequests();
  const updateRequestStatus = useUpdateMedicineRequestStatus();

  const filteredMedicines = medicines?.filter(
    (m) => !search || m.name.toLowerCase().includes(search.toLowerCase()) || (m.genericName ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <AppShell title="💊 Pharmacy Management">
      <div className="dashboard-cards">
        <StatTile label="Total Medicines" value={dashboard?.totalMedicines ?? '…'} />
        <StatTile label="Inventory Value" value={dashboard ? `₹${dashboard.inventoryValue.toFixed(2)}` : '…'} />
        <StatTile label="Low Stock" value={dashboard?.lowStock ?? '…'} tone="warning" />
        <StatTile label="Expired" value={dashboard?.expired ?? '…'} tone="danger" />
        <StatTile label="Expiring Soon" value={dashboard?.expiringSoon ?? '…'} tone="warning" />
        <MachineStatusTile />
      </div>

      <div className="tabs">
        {(['inventory', 'stockin', 'stockout', 'audit', 'requests'] as Tab[]).map((t) => (
          <button key={t} type="button" className={`tab-button${tab === t ? ' tab-button--active' : ''}`} onClick={() => setTab(t)}>
            {t === 'inventory' && '📦 Inventory'}
            {t === 'stockin' && '📥 Stock In'}
            {t === 'stockout' && '📤 Stock Out'}
            {t === 'audit' && '📋 Audit Logs'}
            {t === 'requests' && '📨 Medicine Requests'}
          </button>
        ))}
      </div>

      {tab === 'inventory' && (
        <div className="info-card">
          <div className="toolbar">
            <input className="search-input" placeholder="Search medicine..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <button type="button" className="btn-primary" onClick={() => setModal('add')}>
              ➕ Add Medicine
            </button>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Medicine ID</th>
                <th>Name</th>
                <th>Qty</th>
                <th>Concentration</th>
                <th>Expiry</th>
                <th>Stock</th>
                <th>Price</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredMedicines?.map((m) => (
                <tr key={m.id} className={rowTone(m)}>
                  <td>{m.medicineCode}</td>
                  <td>{m.name}</td>
                  <td>{m.unitMl} ml</td>
                  <td>{m.concentration}</td>
                  <td>{m.expiryDate ? new Date(m.expiryDate).toLocaleDateString() : '—'}</td>
                  <td>{m.stockQty}</td>
                  <td>₹{m.pricePerUnit.toFixed(2)}</td>
                  <td>
                    <span className={`status-badge status-${m.status.toLowerCase()}`}>{m.status}</span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        setEditingMedicine(m);
                        setModal('edit');
                      }}
                    >
                      ✏️
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="modal-footer" style={{ justifyContent: 'flex-start', marginTop: 16 }}>
            <button type="button" className="btn-readmit" onClick={() => setModal('stockin')}>
              📥 Stock In
            </button>
            <button type="button" className="btn-warning" onClick={() => setModal('stockout')}>
              📤 Stock Out
            </button>
          </div>
        </div>
      )}

      {tab === 'stockin' && (
        <div className="info-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Medicine</th>
                <th>Qty</th>
                <th>Unit Cost</th>
                <th>Supplier</th>
                <th>Invoice</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {(stockInTx as any[])?.map((t) => (
                <tr key={t.id}>
                  <td>{t.medicine?.name}</td>
                  <td>{t.quantity}</td>
                  <td>₹{t.unitCost}</td>
                  <td>{t.supplier}</td>
                  <td>{t.invoiceNo ?? '—'}</td>
                  <td>{new Date(t.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'stockout' && (
        <div className="info-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Medicine</th>
                <th>Qty</th>
                <th>Patient</th>
                <th>Payment</th>
                <th>Total</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {(stockOutTx as any[])?.map((t) => (
                <tr key={t.id}>
                  <td>{t.medicine?.name}</td>
                  <td>{t.quantity}</td>
                  <td>{t.isDamaged ? '🚫 Damaged/Expiry' : (t.patient?.fullName ?? '—')}</td>
                  <td>{t.paymentMethod ?? '—'}</td>
                  <td>{t.totalAmount != null ? `₹${t.totalAmount}` : '—'}</td>
                  <td>{new Date(t.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'audit' && (
        <div className="info-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Actor</th>
                <th>Action</th>
                <th>Table</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {(auditLogs as any[])?.map((a) => (
                <tr key={a.id}>
                  <td>{a.actorType}</td>
                  <td>{a.action}</td>
                  <td>{a.entityTable}</td>
                  <td>{new Date(a.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'requests' && (
        <div className="info-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Medicine</th>
                <th>Remarks</th>
                <th>Status</th>
                <th>Requested</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests?.length === 0 && (
                <tr>
                  <td colSpan={6}>No medicine requests from doctors.</td>
                </tr>
              )}
              {requests?.map((r) => (
                <tr key={r.id}>
                  <td>{r.patient.fullName}</td>
                  <td>{r.medicineName}</td>
                  <td>{r.notes ?? '—'}</td>
                  <td>
                    <span className={`status-badge status-${r.status}`}>{r.status}</span>
                  </td>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>
                    {r.status === 'pending' ? (
                      <>
                        <button type="button" className="btn-fulfill" onClick={() => updateRequestStatus.mutate({ id: r.id, status: 'fulfilled' })}>
                          ✅ Fulfill
                        </button>{' '}
                        <button type="button" className="btn-reject" onClick={() => updateRequestStatus.mutate({ id: r.id, status: 'rejected' })}>
                          ❌ Reject
                        </button>
                      </>
                    ) : (
                      'Done'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(modal === 'add' || modal === 'edit') && (
        <AddEditMedicineModal
          medicine={modal === 'edit' ? editingMedicine : undefined}
          onClose={() => {
            setModal(null);
            setEditingMedicine(undefined);
          }}
        />
      )}
      {modal === 'stockin' && <StockInModal onClose={() => setModal(null)} />}
      {modal === 'stockout' && <StockOutModal onClose={() => setModal(null)} />}
    </AppShell>
  );
}
