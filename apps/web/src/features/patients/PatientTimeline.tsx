import { DISCHARGE_OUTCOME_LABEL, DOCTOR_CHANGE_REASON_LABEL, MACHINE_TYPE_LABEL, ROLE_LABEL, type DischargeOutcome, type DoctorChangeReason, type MachineType } from '@infusion/shared-types';
import type { PatientHistoryEntry } from './api';
import { OUT_PATIENT } from '../rooms/api';

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
  ROOM_CHANGED: 'badge-room-changed',
  MACHINE_TAGGED: 'badge-machine',
  MACHINE_UNTAGGED: 'badge-machine',
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

/** Who wrote the entry, with their role ("admin1 (Admin)"); a machine shows its code. */
function ActedBy({ entry }: { entry: PatientHistoryEntry }) {
  if (!entry.actedBy) return null;
  return (
    <p className="timeline-entry__meta">
      👤 By: {entry.actedBy}
      {entry.actedByRole ? ` (${ROLE_LABEL[entry.actedByRole]})` : ''}
    </p>
  );
}

function EntryBody({ entry }: { entry: PatientHistoryEntry }) {
  const s = entry.snapshot ?? {};

  if (entry.action === 'DOCTOR_UPDATE') {
    return (
      <div className="timeline-entry__body">
        <ActedBy entry={entry} />
        {s.diagnosis ? <p>Diagnosis: {String(s.diagnosis)}</p> : null}
        {s.doctorNotes ? <p>Notes: {String(s.doctorNotes)}</p> : null}
        {!s.diagnosis && !s.doctorNotes ? <p className="timeline-entry__nodata">(No summary details)</p> : null}
      </div>
    );
  }

  if (entry.action === 'DISCHARGE') {
    const outcome = s.dischargeOutcome as DischargeOutcome | null | undefined;
    return (
      <div className="timeline-entry__body">
        <p>
          Outcome: <b>{outcome ? DISCHARGE_OUTCOME_LABEL[outcome] ?? outcome : 'not recorded'}</b>
        </p>
        {s.dischargeRemarks ? <p>Remarks: {String(s.dischargeRemarks)}</p> : null}
        <ActedBy entry={entry} />
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
        <ActedBy entry={entry} />
      </div>
    );
  }

  if (entry.action === 'MACHINE_TAGGED' || entry.action === 'MACHINE_UNTAGGED') {
    const type = String(s.machineType ?? '');
    return (
      <div className="timeline-entry__body">
        <p>
          {entry.action === 'MACHINE_TAGGED' ? 'Machine attached' : 'Machine removed'}: <b>{String(s.machineCode ?? '?')}</b>
          {type ? ` (${MACHINE_TYPE_LABEL[type as MachineType] ?? type})` : ''}
        </p>
        <ActedBy entry={entry} />
      </div>
    );
  }

  if (entry.action === 'ROOM_CHANGED') {
    const moved = Array.isArray(s.machinesMoved) ? (s.machinesMoved as string[]) : [];
    return (
      <div className="timeline-entry__body">
        <p>
          Room: {String(s.fromRoom ?? OUT_PATIENT)} → <b>{String(s.toRoom ?? '?')}</b>
        </p>
        {moved.length ? <p>Machines moved with the patient: {moved.join(', ')}</p> : null}
        {s.note ? <p>Note: {String(s.note)}</p> : null}
        <ActedBy entry={entry} />
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
        <ActedBy entry={entry} />
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
        <ActedBy entry={entry} />
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
      <ActedBy entry={entry} />
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
