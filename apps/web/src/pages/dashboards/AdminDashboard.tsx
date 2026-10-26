import { useState } from 'react';
import type { DoctorSummary, MachineType } from '@infusion/shared-types';
import { MACHINE_TYPES } from '@infusion/shared-types';
import { AppShell } from '../../components/AppShell';
import { StatTile } from '../../components/StatTile';
import { useFleetStatus, useCreateMachine, useIssueMachineCredential } from '../../features/machines/api';
import { AssignPatientModal } from '../../features/machines/AssignPatientModal';
import { MachineMirrorView } from '../../features/machines/MachineMirrorView';
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
  const issueCredential = useIssueMachineCredential();
  const untag = useUntagPatientMachine();
  const [form, setForm] = useState({ machineCode: '', machineType: 'INFUSION_PUMP' as MachineType, location: '' });
  const [issued, setIssued] = useState<{ machineId: string; machineCode: string; token: string } | null>(null);
  const [assignModal, setAssignModal] = useState<{ machineId: string; machineCode: string } | null>(null);
  const [mirrorMachine, setMirrorMachine] = useState<{ machineId: string; machineCode: string } | null>(null);

  const patientName = (id: string) => allPatients?.find((p) => p.id === id)?.fullName ?? id;

  const registerMachine = async () => {
    if (!form.machineCode) return;
    await createMachine.mutateAsync(form);
    setForm({ machineCode: '', machineType: 'INFUSION_PUMP', location: '' });
  };

  const issueFor = async (machineId: string) => {
    setIssued(await issueCredential.mutateAsync(machineId));
  };

  const unassign = (machineId: string, patientId: string) => {
    untag.mutate({ id: patientId, machineId });
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
            <th>Location</th>
            <th>Status</th>
            <th>Assigned Patient</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {fleet?.machines.map((m) => (
            <tr key={m.id}>
              <td>{m.machineCode}</td>
              <td>{m.machineType}</td>
              <td>{m.location ?? '—'}</td>
              <td>
                <span className={`badge ${m.status === 'online' ? 'badge-yes' : 'badge-no'}`}>{m.status}</span>
              </td>
              <td>{m.assignedPatientId ? patientName(m.assignedPatientId) : '—'}</td>
              <td>
                <button type="button" className="link-button" onClick={() => issueFor(m.id)}>
                  🔑 Issue Credential
                </button>{' '}
                {m.machineType === 'INFUSION_PUMP' && (
                  <>
                    <button type="button" className="link-button" onClick={() => setMirrorMachine({ machineId: m.id, machineCode: m.machineCode })}>
                      📟 View Live
                    </button>{' '}
                  </>
                )}
                {m.assignedPatientId ? (
                  <button type="button" className="link-button" onClick={() => unassign(m.id, m.assignedPatientId!)} disabled={untag.isPending}>
                    ✖ Unassign
                  </button>
                ) : (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setAssignModal({ machineId: m.id, machineCode: m.machineCode })}
                  >
                    🧑‍⚕️ Assign Patient
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {assignModal && (
        <AssignPatientModal machineId={assignModal.machineId} machineCode={assignModal.machineCode} onClose={() => setAssignModal(null)} />
      )}

      {mirrorMachine && (
        <MachineMirrorView machineId={mirrorMachine.machineId} machineCode={mirrorMachine.machineCode} onClose={() => setMirrorMachine(null)} />
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
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Location
          <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        </label>
      </div>
      <button type="button" className="btn-primary" onClick={registerMachine} disabled={createMachine.isPending}>
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
