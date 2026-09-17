import { useState } from 'react';
import type { ClaimDecisionAction } from '@infusion/shared-types';
import { AppShell } from '../../components/AppShell';
import { MachineStatusTile } from '../../components/MachineStatusTile';
import { useClaims } from '../../features/insurance/api';
import { ClaimActionModal } from '../../features/insurance/ClaimActionModal';
import { RevokeModal } from '../../features/insurance/RevokeModal';
import { PatientDetailsModal } from '../../features/patients/PatientDetailsModal';

const ACTIONABLE = ['draft', 'submitted', 'under_review', 'documents_required'];
const REVOCABLE = ['partially_approved', 'rejected'];

const STATUS_OPTIONS = [
  ['', 'All Statuses'],
  ['draft', 'Draft'],
  ['submitted', 'Submitted'],
  ['under_review', 'Under Review'],
  ['documents_required', 'Documents Required'],
  ['approved', 'Approved'],
  ['partially_approved', 'Partially Approved'],
  ['rejected', 'Rejected'],
  ['closed', 'Closed'],
];

type Modal = { kind: 'action'; claimId: string; action: ClaimDecisionAction } | { kind: 'revoke'; claimId: string } | { kind: 'patient'; patientId: string } | null;

export function InsuranceDashboard() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const { data: claims, isLoading } = useClaims(status, search);

  return (
    <AppShell title="📄 Insurance Claims">
      <div className="dashboard-cards">
        <MachineStatusTile />
      </div>

      <div className="toolbar">
        <input className="search-input" placeholder="Search by claim ID, patient, IP..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>

      <div className="info-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>IP</th>
              <th>Patient Name</th>
              <th>Insurance Company</th>
              <th>Policy</th>
              <th>Diagnosis</th>
              <th>Status</th>
              <th>Remarks</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={8}>Loading...</td>
              </tr>
            )}
            {!isLoading && claims?.length === 0 && (
              <tr>
                <td colSpan={8}>No claims found.</td>
              </tr>
            )}
            {claims?.map((c) => (
              <tr key={c.id}>
                <td>
                  <button type="button" className="link-button" onClick={() => setModal({ kind: 'patient', patientId: c.patientId })}>
                    {c.patient.ipNumber}
                  </button>
                </td>
                <td>{c.patient.fullName}</td>
                <td>{c.insuranceCompany?.name ?? '—'}</td>
                <td>{c.policyNumber ?? '—'}</td>
                <td>{c.patient.diagnosis ?? '—'}</td>
                <td>
                  <span className={`status-badge status-${c.status}`}>{c.status.replace(/_/g, ' ')}</span>
                </td>
                <td className="remarks-text" title={c.remarks ?? ''}>
                  {c.remarks ?? '—'}
                </td>
                <td>
                  {ACTIONABLE.includes(c.status) ? (
                    <div className="inline-buttons">
                      <button type="button" className="btn-approve" onClick={() => setModal({ kind: 'action', claimId: c.id, action: 'Approve' })}>
                        Approve
                      </button>
                      <button type="button" className="btn-partial" onClick={() => setModal({ kind: 'action', claimId: c.id, action: 'Partially Approve' })}>
                        Partially
                      </button>
                      <button type="button" className="btn-reject" onClick={() => setModal({ kind: 'action', claimId: c.id, action: 'Reject' })}>
                        Reject
                      </button>
                      <button type="button" className="btn-docs" onClick={() => setModal({ kind: 'action', claimId: c.id, action: 'Request Documents' })}>
                        Docs
                      </button>
                    </div>
                  ) : REVOCABLE.includes(c.status) ? (
                    <div className="inline-buttons">
                      <button type="button" className="btn-revoke" onClick={() => setModal({ kind: 'revoke', claimId: c.id })}>
                        Revoke
                      </button>
                      <span className="locked-label">Locked</span>
                    </div>
                  ) : (
                    <span className="locked-label">Locked</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal?.kind === 'action' && <ClaimActionModal claimId={modal.claimId} action={modal.action} onClose={() => setModal(null)} />}
      {modal?.kind === 'revoke' && <RevokeModal claimId={modal.claimId} onClose={() => setModal(null)} />}
      {modal?.kind === 'patient' && <PatientDetailsModal patientId={modal.patientId} onClose={() => setModal(null)} />}
    </AppShell>
  );
}
