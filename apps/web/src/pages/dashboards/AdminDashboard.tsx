import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DoctorSummary, MachineSummary, MachineType } from '@infusion/shared-types';
import { MACHINE_TYPES, MACHINE_TYPE_LABEL, isVigilMachineType } from '@infusion/shared-types';
import { AppShell } from '../../components/AppShell';
import { ConfirmTypedModal } from '../../components/ConfirmTypedModal';
import { useAuth } from '../../auth/AuthContext';
import { StatTile } from '../../components/StatTile';
import { useFleetStatus, useCreateMachine } from '../../features/machines/api';
import { AssignPatientModal } from '../../features/machines/AssignPatientModal';
import { IssueCredentialModal } from '../../features/machines/IssueCredentialModal';
import { MachineValuesModal } from '../../features/machines/MachineValuesModal';
import { MachineMirrorView } from '../../features/machines/MachineMirrorView';
import { VigilMirrorView } from '../../features/machines/VigilMirrorView';
import { PatientLinksCard } from '../../features/patients/PatientLinksCard';
import { RoomsCard } from '../../features/rooms/RoomsCard';
import { useMoveMachine, useRooms } from '../../features/rooms/api';
import { ApiError } from '../../lib/api';
import {
  useAllDoctors,
  useCreateDoctor,
  useArchiveDoctor,
  useUnarchiveDoctor,
  useResetDoctorPassword,
  usePromoteDoctor,
} from '../../features/doctors/api';
import { usePatients, useUntagPatientMachine } from '../../features/patients/api';
import { ModifyDoctorModal } from '../../features/doctors/ModifyDoctorModal';
import { DoctorHistoryModal } from '../../features/doctors/DoctorHistoryModal';

function FleetPanel() {
  const { data: fleet } = useFleetStatus();
  const { data: allPatients } = usePatients('');
  const createMachine = useCreateMachine();
  const untag = useUntagPatientMachine();
  const { user } = useAuth();
  // Machine credentials are issued by the superuser only (their Admin tab).
  const isSuperuser = user?.role === 'superuser';
  const { data: rooms } = useRooms();
  const moveMachine = useMoveMachine();
  const [form, setForm] = useState({ machineCode: '', machineType: 'INFUSION_PUMP' as MachineType, roomId: '' });
  const [moving, setMoving] = useState<{ machineId: string; machineCode: string; roomId: string } | null>(null);
  const [fleetError, setFleetError] = useState('');
  const [moveError, setMoveError] = useState('');
  const [issued, setIssued] = useState<{ machineId: string; machineCode: string; token: string } | null>(null);
  // Issuing a credential cuts the machine off until it gets the new one, so it needs CONFIRM typed first.
  const [confirmIssue, setConfirmIssue] = useState<MachineSummary | null>(null);
  // Superuser: which of a machine's values the portal shows (display only; everything is stored).
  const [valuesFor, setValuesFor] = useState<MachineSummary | null>(null);
  // Unassigning stops a machine's data being shown and checked for its patient: CONFIRM first too.
  const [confirmUnassign, setConfirmUnassign] = useState<MachineSummary | null>(null);
  const [assignModal, setAssignModal] = useState<{ machineId: string; machineCode: string } | null>(null);
  const [mirrorMachine, setMirrorMachine] = useState<{ machineId: string; machineCode: string; pump: boolean } | null>(null);

  const patientName = (id: string) => allPatients?.find((p) => p.id === id)?.fullName ?? id;

  const registerMachine = async () => {
    setFleetError('');
    if (!form.machineCode || !form.roomId) return setFleetError('Enter the machine code and choose its room.');
    try {
      await createMachine.mutateAsync(form);
      setForm({ machineCode: '', machineType: 'INFUSION_PUMP', roomId: '' });
    } catch (e) {
      setFleetError(e instanceof ApiError ? e.message : 'Could not register the machine.');
    }
  };

  const confirmMove = async () => {
    if (!moving) return;
    setMoveError('');
    try {
      await moveMachine.mutateAsync({ machineId: moving.machineId, roomId: moving.roomId });
      setMoving(null);
    } catch (e) {
      setMoveError(e instanceof ApiError ? e.message : 'Could not move the machine.');
    }
  };


  return (
    <div className="info-card">
      <h4 className="form-section-title">🖥️ Machine Fleet</h4>
      <div className="dashboard-cards">
        <StatTile label="Total Machines" value={fleet?.totalMachines ?? '…'} />
        <StatTile label="Connected" value={fleet?.connectedMachines ?? '…'} tone="success" />
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Type</th>
            <th>Room</th>
            <th>Status</th>
            <th>Assigned Patient</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {fleet?.machines.map((m) => (
            <tr key={m.id}>
              <td>{m.machineCode}</td>
              <td>{MACHINE_TYPE_LABEL[m.machineType as MachineType] ?? m.machineType}</td>
              <td>
                {moving?.machineId === m.id ? (
                  <span className="room-move">
                    <select value={moving.roomId} onChange={(e) => setMoving({ ...moving, roomId: e.target.value })}>
                      <option value="">-- Room --</option>
                      {rooms?.filter((r) => r.id !== m.room?.id).map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="link-button" disabled={!moving.roomId || moveMachine.isPending} onClick={() => void confirmMove()}>
                      Move
                    </button>
                    <button type="button" className="link-button" onClick={() => setMoving(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <>
                    {m.room?.name ?? '—'}{' '}
                    <button type="button" className="link-button" onClick={() => setMoving({ machineId: m.id, machineCode: m.machineCode, roomId: '' })}>
                      ↔ Move
                    </button>
                  </>
                )}
              </td>
              <td>
                <span
                  className={`badge ${m.sendingData ? 'badge-yes' : 'badge-no'}`}
                  title={m.lastSeenAt ? `Last heard from ${new Date(m.lastSeenAt).toLocaleString()}` : 'Never heard from'}
                >
                  {m.sendingData ? 'online' : 'offline'}
                </span>
              </td>
              <td>
                {m.assignedPatientId ? (
                  <>
                    <Link to={`/central-station?patient=${encodeURIComponent(m.assignedPatientId)}`}>{patientName(m.assignedPatientId)}</Link>
                    {m.roomMismatch && (
                      <span className="status-badge status-pending room-mismatch" title="The patient is in a different room">
                        ⚠ room mismatch
                      </span>
                    )}
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td className="actions-cell">
                {/* Same order on every row: look (View Live, Values), then what changes something (red outline). */}
                <div className="row-actions">
                  {(m.machineType === 'INFUSION_PUMP' || isVigilMachineType(m.machineType)) && (
                    <button
                      type="button"
                      className="act"
                      onClick={() => setMirrorMachine({ machineId: m.id, machineCode: m.machineCode, pump: m.machineType === 'INFUSION_PUMP' })}
                    >
                      📟 View Live
                    </button>
                  )}
                  {isSuperuser && isVigilMachineType(m.machineType) && (
                    <button type="button" className="act" onClick={() => setValuesFor(m)}>
                      👁 Values
                    </button>
                  )}
                  {m.assignedPatientId ? (
                    <button type="button" className="act act--danger" onClick={() => setConfirmUnassign(m)}>
                      ✖ Unassign
                    </button>
                  ) : (
                    <button type="button" className="act act--primary" onClick={() => setAssignModal({ machineId: m.id, machineCode: m.machineCode })}>
                      🔗 Assign
                    </button>
                  )}
                  {isSuperuser && (
                    <button type="button" className="act act--danger" onClick={() => setConfirmIssue(m)}>
                      🔑 Credential
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {moveError && <p className="form-error">{moveError}</p>}

      {assignModal && (
        <AssignPatientModal
          machineId={assignModal.machineId}
          machineCode={assignModal.machineCode}
          room={fleet?.machines.find((x) => x.id === assignModal.machineId)?.room ?? null}
          onClose={() => setAssignModal(null)}
        />
      )}

      {mirrorMachine?.pump && (
        <MachineMirrorView machineId={mirrorMachine.machineId} machineCode={mirrorMachine.machineCode} onClose={() => setMirrorMachine(null)} />
      )}
      {mirrorMachine && !mirrorMachine.pump && (
        <VigilMirrorView machineCode={mirrorMachine.machineCode} onClose={() => setMirrorMachine(null)} />
      )}

      {confirmUnassign?.assignedPatientId && (
        <ConfirmTypedModal
          title={`✖ Unassign ${confirmUnassign.machineCode}`}
          action="Unassign machine"
          busyLabel="Unassigning…"
          onConfirm={async () => {
            await untag.mutateAsync({ id: confirmUnassign.assignedPatientId!, machineId: confirmUnassign.id });
            setConfirmUnassign(null);
          }}
          onClose={() => setConfirmUnassign(null)}
        >
          <p className="form-error">
            ⚠️ <strong>{confirmUnassign.machineCode}</strong> will no longer be attached to{' '}
            <strong>{patientName(confirmUnassign.assignedPatientId)}</strong>. From that moment its readings are not shown on their
            page and no alarm rules run on it for them.
          </p>
          {confirmUnassign.sendingData && (
            <p className="form-error">
              <strong>{confirmUnassign.machineCode} is sending data right now.</strong>
            </p>
          )}
          <p>Only do this when the machine has really been taken off this patient. It is recorded in the patient&apos;s timeline.</p>
        </ConfirmTypedModal>
      )}

      {valuesFor && <MachineValuesModal machineId={valuesFor.id} machineCode={valuesFor.machineCode} onClose={() => setValuesFor(null)} />}

      {confirmIssue && (
        <IssueCredentialModal
          machine={confirmIssue}
          onClose={() => setConfirmIssue(null)}
          onIssued={(credential) => {
            setIssued(credential);
            setConfirmIssue(null);
          }}
        />
      )}

      {issued && (
        <div className="form-hint">
          <p>
            ⚠️ Credential for <strong>{issued.machineCode}</strong>. Copy it now; the token is shown only once. A device
            (e.g. the ESP32 gateway's <code>secrets.h</code>) needs both:
          </p>
          <p>
            Machine ID: <code data-allow-copy>{issued.machineId}</code> <CopyButton text={issued.machineId} />
          </p>
          <p>
            Token: <code data-allow-copy>{issued.token}</code> <CopyButton text={issued.token} />
          </p>
        </div>
      )}

      <h4 className="form-section-title">➕ Register New Machine</h4>
      <div className="form-row form-row--4 patient-form">
        <label>
          Machine Code
          <input value={form.machineCode} onChange={(e) => setForm({ ...form, machineCode: e.target.value })} placeholder="e.g. PUMP-002" />
        </label>
        <label>
          Machine Type
          <select value={form.machineType} onChange={(e) => setForm({ ...form, machineType: e.target.value as MachineType })}>
            {MACHINE_TYPES.map((t) => (
              <option key={t} value={t}>
                {MACHINE_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Room
          <select value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
            <option value="">-- Select --</option>
            {rooms?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {fleetError && <p className="form-error">{fleetError}</p>}
      <button type="button" className="btn-primary" onClick={() => void registerMachine()} disabled={createMachine.isPending}>
        ➕ Register Machine
      </button>
    </div>
  );
}

function ManageDoctorsPanel() {
  const [view, setView] = useState<'active' | 'archived'>('active');
  const { data: doctors } = useAllDoctors(view === 'archived');
  const createDoctor = useCreateDoctor();
  const archive = useArchiveDoctor();
  const unarchive = useUnarchiveDoctor();
  const resetPassword = useResetDoctorPassword();
  const promote = usePromoteDoctor();

  const [form, setForm] = useState({ name: '', qualification: '', specialty: '' });
  const [createdCreds, setCreatedCreds] = useState<string | null>(null);
  const [modal, setModal] = useState<{ kind: 'modify' | 'history'; doctor: DoctorSummary } | null>(null);

  const visibleDoctors = doctors?.filter((d) => (view === 'active' ? d.isActive : !d.isActive));

  const addDoctor = async () => {
    if (!form.name || !form.qualification || !form.specialty) return;
    const result = await createDoctor.mutateAsync(form);
    setCreatedCreds(`✅ Doctor added! Login ID: ${result.loginId}, Password: ${result.tempPassword}`);
    setForm({ name: '', qualification: '', specialty: '' });
  };

  return (
    <div className="info-card">
      <h4 className="form-section-title">➕ Add New Doctor</h4>
      <div className="form-row form-row--4 patient-form">
        <label>
          Doctor Name *
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Sandeep Matari" />
        </label>
        <label>
          Qualification *
          <input value={form.qualification} onChange={(e) => setForm({ ...form, qualification: e.target.value })} placeholder="e.g. MBBS, MD" />
        </label>
        <label>
          Specialization *
          <input value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} placeholder="e.g. Cardiology" />
        </label>
      </div>
      <button type="button" className="btn-primary" onClick={addDoctor} disabled={createDoctor.isPending}>
        ➕ Add Doctor
      </button>
      {createdCreds && <p>{createdCreds}</p>}

      <h4 className="form-section-title">📋 Doctor List</h4>
      <div className="toolbar">
        <button type="button" className={view === 'active' ? 'btn-primary' : 'btn-secondary'} onClick={() => setView('active')}>
          ✅ Active
        </button>
        <button type="button" className={view === 'archived' ? 'btn-primary' : 'btn-secondary'} onClick={() => setView('archived')}>
          🗂️ Archived
        </button>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Doctor Name</th>
            <th>Qualification</th>
            <th>Specialization</th>
            <th>Login ID</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {visibleDoctors?.length === 0 && (
            <tr>
              <td colSpan={6}>No doctors found.</td>
            </tr>
          )}
          {visibleDoctors?.map((d) => (
            <tr key={d.id}>
              <td>
                <button type="button" className="link-button" onClick={() => setModal({ kind: 'history', doctor: d })}>
                  Dr. {d.name}
                </button>
              </td>
              <td>{d.qualification}</td>
              <td>{d.specialty}</td>
              <td>{d.loginId ?? '—'}</td>
              <td>
                {d.isTemporary ? (
                  <span className="status-badge status-inactive" title="Bedside-created, no login account — attributed to the reporting machine">
                    🚑 Temporary
                  </span>
                ) : (
                  <span className={`status-badge status-${d.isActive ? 'active' : 'inactive'}`}>{d.isActive ? 'Active' : 'Archived'}</span>
                )}
              </td>
              <td>
                {d.isTemporary ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => promote.mutate(d.id, { onSuccess: (r) => setCreatedCreds(`✅ Promoted to a real account! Login ID: ${r.loginId}, Password: ${r.tempPassword}`) })}
                    disabled={promote.isPending}
                  >
                    ⬆️ Promote to account
                  </button>
                ) : d.isActive ? (
                  <>
                    <button type="button" className="link-button" onClick={() => setModal({ kind: 'modify', doctor: d })}>
                      ✏️
                    </button>{' '}
                    <button type="button" className="link-button" onClick={() => archive.mutate(d.id)}>
                      🗄️ Archive
                    </button>{' '}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => resetPassword.mutate(d.id, { onSuccess: (r) => setCreatedCreds(`🔑 Password reset for ${r.loginId}: ${r.tempPassword}`) })}
                    >
                      🔑
                    </button>
                  </>
                ) : (
                  <button type="button" className="link-button" onClick={() => unarchive.mutate(d.id)}>
                    📂 Unarchive
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {modal?.kind === 'modify' && <ModifyDoctorModal doctor={modal.doctor} onClose={() => setModal(null)} />}
      {modal?.kind === 'history' && (
        <DoctorHistoryModal doctorId={modal.doctor.id} doctorName={modal.doctor.name} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

export function AdminDashboard() {
  return (
    <AppShell title="🏥 Admin — Fleet Dashboard">
      <FleetPanel />
      <RoomsCard />
      <PatientLinksCard />
      <ManageDoctorsPanel />
    </AppShell>
  );
}

/** Copies a value shown once (e.g. a machine credential); the rest of the site can't be copied. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className="link-button" onClick={() => void copy()}>
      {copied ? '✓ Copied' : '📋 Copy'}
    </button>
  );
}
