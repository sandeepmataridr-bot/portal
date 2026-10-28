import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../../components/AppShell';
import { StatTile } from '../../components/StatTile';
import { useAuth } from '../../auth/AuthContext';
import { useActiveDoctors } from '../../features/doctors/api';
import { usePatients, usePatient } from '../../features/patients/api';
import { PatientTimeline } from '../../features/patients/PatientTimeline';
import { MoveRoomForm } from '../../features/patients/MoveRoomForm';
import { OUT_PATIENT } from '../../features/rooms/api';
import { InfusionStepsPanel } from '../../features/infusions/InfusionStepsPanel';
import { DoctorClinicalForm } from './DoctorClinicalForm';
import { RequestMedicineForm } from './RequestMedicineForm';

export function DoctorDashboard() {
  const { user } = useAuth();
  const { data: doctors } = useActiveDoctors();
  const me = doctors?.find((d) => d.userId === user?.id);

  const { data: patients } = usePatients('', me?.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: patient } = usePatient(selectedId);
  // The doctor can give their patient a room (an out patient has none) or move them.
  const [movingRoom, setMovingRoom] = useState(false);

  const activeAssignment = patient?.machineAssignments[0];

  return (
    <AppShell title={`👨‍⚕️ Doctor Panel${me ? ` — Dr. ${me.name}` : ''}`}>
      {/* This doctor's own patients (all of them, admitted and discharged); deaths are a discharge outcome. */}
      <div className="dashboard-cards">
        <StatTile label="Patients treated" value={patients?.length ?? '…'} />
        <StatTile label="In-patients" value={patients ? patients.filter((p) => !p.discharged).length : '…'} tone="success" />
        <StatTile
          label="Discharged"
          value={patients ? patients.filter((p) => p.discharged && p.dischargeOutcome !== 'DIED').length : '…'}
          tone="info"
        />
        <StatTile label="Died" value={patients ? patients.filter((p) => p.dischargeOutcome === 'DIED').length : '…'} tone="danger" />
      </div>

      <div className="info-card">
        <label>
          Active Patients
          <select value={selectedId ?? ''} onChange={(e) => (setSelectedId(e.target.value || null), setMovingRoom(false))}>
            <option value="">-- Select --</option>
            {patients?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName} ({p.ipNumber})
              </option>
            ))}
          </select>
        </label>
        {patients && patients.length === 0 && (
          <p className="form-hint">
            No patients are assigned to you. Reception chooses each patient&apos;s doctor when registering them.
          </p>
        )}
        {patient && (
          <Link className="btn-primary pm-open" to={`/central-station?patient=${encodeURIComponent(patient.id)}`}>
            🩺 Open patient monitor
            {patient.machineAssignments.length > 0 &&
              ` (${patient.machineAssignments.length} machine${patient.machineAssignments.length === 1 ? '' : 's'})`}
          </Link>
        )}
        {patient && (
          <div className="doctor-room">
            <span>
              Room: <strong>{patient.room?.name ?? OUT_PATIENT}</strong>
            </span>{' '}
            {!patient.discharged && !movingRoom && (
              <button type="button" className="link-button" onClick={() => setMovingRoom(true)}>
                ✏️ {patient.room ? 'Move' : 'Assign room'}
              </button>
            )}
            {movingRoom && <MoveRoomForm patient={patient} onDone={() => setMovingRoom(false)} />}
          </div>
        )}
      </div>

      {patient && (
        <>
          <DoctorClinicalForm patient={patient} />

          {patient.insured && (
            <div className="info-card">
              <h4 className="form-section-title">🛡️ Insurance Details</h4>
              <div className="detail-grid">
                <div>
                  <b>Claim Status</b>
                  <p>{patient.insuranceClaims[0]?.status ?? 'No claim'}</p>
                </div>
              </div>
            </div>
          )}

          <RequestMedicineForm patientId={patient.id} />

          <InfusionStepsPanel patientId={patient.id} machineId={activeAssignment?.machineId ?? null} />

          <div className="info-card">
            <h4 className="form-section-title">📝 Doctor Summary History</h4>
            <PatientTimeline entries={patient.history} filterPrefix="DOCTOR_UPDATE" />
          </div>
        </>
      )}
    </AppShell>
  );
}
