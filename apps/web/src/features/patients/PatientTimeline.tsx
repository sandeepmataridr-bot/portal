import { DOCTOR_CHANGE_REASON_LABEL, type DoctorChangeReason } from '@infusion/shared-types';
import type { PatientHistoryEntry } from './api';

const BADGE_CLASS: Record<string, string> = {
  REGISTER: 'badge-register',
  READMIT: 'badge-readmit',
  READMIT_UPDATE: 'badge-readmit-update',
  DISCHARGE: 'badge-discharge',
  DOCTOR_UPDATE: 'badge-doctor-update',
  DOCTOR_REASSIGNED: 'badge-doctor-reassigned',
  IDENTITY_UPDATE: 'badge-identity-update',
  IP_LINKED: 'badge-ip-link',
  IP_LINKED_TO: 'badge-ip-link',
  IP_UNLINKED: 'badge-ip-link',
  DOCTOR_SUGGESTION: 'badge-doctor-update',
  DOCTOR_SUGGESTION_DELETED: 'badge-doctor-update',
  INSURANCE_APPROVED: 'badge-insurance-approved',
  INSURANCE_PARTIALLY_APPROVED: 'badge-insurance-partially-approved',
  INSURANCE_REJECTED: 'badge-insurance-rejected',
  INSURANCE_REVOKED: 'badge-insurance-revoked',
  INSURANCE_DOCUMENTS_REQUIRED: 'badge-insurance-documents-required',
};

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

const FIELD_LABEL: Record<string, string> = {
  age: 'Age',
  gender: 'Gender',
  mobile: 'Mobile',
  emergencyContact: 'Emergency contact',
  aadhar: 'Aadhar',
  address: 'Address',
};

function EntryBody({ entry }: { entry: PatientHistoryEntry }) {
  const s = entry.snapshot ?? {};

  if (entry.action === 'DOCTOR_UPDATE') {
    return (
      <div className="timeline-entry__body">
        <p className="timeline-entry__meta">👤 Dr. {entry.actedBy ?? 'Unknown'}</p>
        {s.diagnosis ? <p>Diagnosis: {String(s.diagnosis)}</p> : null}
        {s.doctorNotes ? <p>Notes: {String(s.doctorNotes)}</p> : null}
        {!s.diagnosis && !s.doctorNotes ? <p className="timeline-entry__nodata">(No summary details)</p> : null}
      </div>
    );
  }

  if (entry.action === 'IP_LINKED' || entry.action === 'IP_LINKED_TO' || entry.action === 'IP_UNLINKED') {
    const linked = Array.isArray(s.linked) ? (s.linked as { ipNumber: string | null; fullName: string }[]) : [];
    const ip = (n: unknown, name: unknown) => `IP ${String(n ?? '—')} (${String(name ?? '')})`;
    return (
      <div className="timeline-entry__body">
        {entry.action === 'IP_LINKED' && <p>Linked as duplicates of this IP: {linked.map((l) => ip(l.ipNumber, l.fullName)).join(', ')}</p>}
        {entry.action === 'IP_LINKED_TO' && <p>Linked to main {ip(s.mainIpNumber, s.mainFullName)}</p>}
        {entry.action === 'IP_UNLINKED' && <p>Delinked from {ip(s.otherIpNumber, s.otherFullName)}</p>}
        {s.reason ? <p>Reason: {String(s.reason)}</p> : null}
        {entry.actedBy ? <p className="timeline-entry__meta">👤 By: {entry.actedBy}</p> : null}
      </div>
    );
  }

  if (entry.action === 'IDENTITY_UPDATE') {
    const changes = Array.isArray(s.changes) ? (s.changes as { field: string; from: unknown; to: unknown }[]) : [];
    return (
      <div className="timeline-entry__body">
        {changes.map((c) => (
          <p key={c.field}>
            {FIELD_LABEL[c.field] ?? c.field}: {String(c.from ?? '—')} → <b>{String(c.to ?? '—')}</b>
          </p>
        ))}
        {entry.actedBy ? <p className="timeline-entry__meta">👤 By: {entry.actedBy}</p> : null}
      </div>
    );
  }

  if (entry.action === 'DOCTOR_REASSIGNED') {
    const reason = DOCTOR_CHANGE_REASON_LABEL[s.reason as DoctorChangeReason] ?? String(s.reason ?? '');
    return (
      <div className="timeline-entry__body">
        <p>
          Doctor: {s.fromDoctorName ? `Dr. ${String(s.fromDoctorName)}` : 'none'} → <b>Dr. {String(s.toDoctorName ?? '?')}</b>
        </p>
        {reason ? <p>Reason: {reason}</p> : null}
        {s.note ? <p>Note: {String(s.note)}</p> : null}
        {entry.actedBy ? <p className="timeline-entry__meta">👤 By: {entry.actedBy}</p> : null}
      </div>
    );
  }

  if (entry.action.startsWith('INSURANCE_')) {
    return (
      <div className="timeline-entry__body">
        {s.claimStatus ? <p>Status: {String(s.claimStatus)}</p> : null}
        {s.approvalRemarks ? <p>Remarks: {String(s.approvalRemarks)}</p> : null}
        {s.approvedBy ? <p className="timeline-entry__approver">Approved by: {String(s.approvedBy)}</p> : null}
      </div>
    );
  }

  return (
    <div className="timeline-entry__body">
      <p>
        {[
          s.fullName ? `Name: ${s.fullName}` : null,
          s.age != null ? `Age: ${s.age}` : null,
          s.gender ? String(s.gender) : null,
          s.ipNumber ? `IP: ${s.ipNumber}` : null,
          s.discharged != null ? `Discharged: ${s.discharged ? 'Yes' : 'No'}` : null,
        ]
          .filter(Boolean)
          .join(' | ')}
      </p>
      {entry.actedBy ? <p className="timeline-entry__meta">👤 By: {entry.actedBy}</p> : null}
    </div>
  );
}

/**
 * The reference app's versioned patient-history feed, preserved as one
 * shared component rather than rebuilt per page. `filterPrefix` lets a
 * role-specific view narrow to its own action types (e.g. insurance shows
 * only INSURANCE_*) without duplicating the rendering logic.
 */
/** ownIpNumber: entries written under another (linked) IP get a tag with that IP. */
export function PatientTimeline({
  entries,
  filterPrefix,
  ownIpNumber,
}: {
  entries: PatientHistoryEntry[];
  filterPrefix?: string;
  ownIpNumber?: string | null;
}) {
  const filtered = filterPrefix ? entries.filter((e) => e.action.startsWith(filterPrefix)) : entries;

  if (filtered.length === 0) {
    return <p className="timeline-empty">No history recorded.</p>;
  }

  return (
    <div className="timeline">
      {filtered.map((entry) => (
        <div key={entry.id} className="timeline-entry">
          <div className="timeline-entry__header">
            <span className="timeline-entry__version">v{entry.version}</span>
            <span className={`timeline-badge ${BADGE_CLASS[entry.action] ?? 'badge-default'}`}>{entry.action}</span>
            {entry.ipNumber && ownIpNumber && entry.ipNumber !== ownIpNumber && <span className="timeline-entry__ip">IP {entry.ipNumber}</span>}
            <span className="timeline-entry__date">{formatTimestamp(entry.createdAt)}</span>
          </div>
          <EntryBody entry={entry} />
        </div>
      ))}
    </div>
  );
}
