import { useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { StatTile } from '../../components/StatTile';
import { MachineStatusTile } from '../../components/MachineStatusTile';
import { usePatients, useReceptionDashboard } from '../../features/patients/api';
import { RegisterPatientModal } from '../../features/patients/RegisterPatientModal';
import { PatientDetailsModal } from '../../features/patients/PatientDetailsModal';
import { DischargeConfirmModal } from '../../features/patients/DischargeConfirmModal';
import { ReadmitModal } from '../../features/patients/ReadmitModal';

type ActiveModal =
  | { kind: 'register' }
  | { kind: 'details'; patientId: string }
  | { kind: 'discharge'; patientId: string; patientName: string }
  | { kind: 'readmit'; patientId: string }
  | null;

export function ReceptionDashboard() {
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<ActiveModal>(null);
  const { data: stats } = useReceptionDashboard();
  const { data: patients, isLoading } = usePatients(search);

  return (
    <AppShell title="🏥 Reception Dashboard">
      <div className="dashboard-cards">
        <StatTile label="Today's Patients" value={stats?.todayPatients ?? '…'} />
        <StatTile label="Insurance Pending" value={stats?.insurancePending ?? '…'} tone="warning" />
        <StatTile label="Approved" value={stats?.approved ?? '…'} tone="success" />
        <StatTile label="Rejected" value={stats?.rejected ?? '…'} tone="danger" />
        <StatTile label="Discharged" value={stats?.discharged ?? '…'} tone="info" />
        <MachineStatusTile />
      </div>

      <button type="button" className="btn-primary btn-block" onClick={() => setModal({ kind: 'register' })}>
        ➕ Register New Patient
      </button>

      <div className="patient-list">
        <input
          type="text"
          className="search-input"
          placeholder="Search by name, IP..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <table className="data-table">
          <thead>
            <tr>
              <th>IP</th>
              <th>Name</th>
              <th>Doctor</th>
              <th>Insurance</th>
              <th>Discharged</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6}>Loading…</td>
              </tr>
            )}
            {!isLoading && patients?.length === 0 && (
              <tr>
                <td colSpan={6}>No patients found.</td>
              </tr>
            )}
            {patients?.map((p) => (
              <tr key={p.id}>
                <td>
                  <button type="button" className="link-button" onClick={() => setModal({ kind: 'details', patientId: p.id })}>
                    {p.ipNumber}
                  </button>
                </td>
                <td>{p.fullName}</td>
                <td>{p.doctorName ?? '—'}</td>
                <td>{p.claimStatus ?? 'No Claim'}</td>
                <td>{p.discharged ? 'Yes' : 'No'}</td>
                <td>
                  {p.discharged ? (
                    <button type="button" className="btn-readmit" onClick={() => setModal({ kind: 'readmit', patientId: p.id })}>
                      Readmit
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-discharge"
                      onClick={() => setModal({ kind: 'discharge', patientId: p.id, patientName: p.fullName })}
                    >
                      Discharge
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal?.kind === 'register' && <RegisterPatientModal onClose={() => setModal(null)} />}
      {modal?.kind === 'details' && <PatientDetailsModal patientId={modal.patientId} onClose={() => setModal(null)} />}
      {modal?.kind === 'discharge' && (
        <DischargeConfirmModal patientId={modal.patientId} patientName={modal.patientName} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'readmit' && <ReadmitModal patientId={modal.patientId} onClose={() => setModal(null)} />}
    </AppShell>
  );
}
