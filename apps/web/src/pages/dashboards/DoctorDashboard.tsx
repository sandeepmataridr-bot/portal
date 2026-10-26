import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../../components/AppShell';
import { StatTile } from '../../components/StatTile';
import { MachineStatusTile } from '../../components/MachineStatusTile';
import { useAuth } from '../../auth/AuthContext';
import { useActiveDoctors } from '../../features/doctors/api';
import { usePatients, usePatient } from '../../features/patients/api';
import { PatientTimeline } from '../../features/patients/PatientTimeline';
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

  const activeAssignment = patient?.machineAssignments[0];

  return (
    <AppShell title={`👨‍⚕️ Doctor Panel${me ? ` — Dr. ${me.name}` : ''}`}>
      <div className="dashboard-cards">
        <StatTile label="My Patients" value={patients?.length ?? '…'} />
        <MachineStatusTile />
      </div>

      <div className="info-card">
        <label>
          Active Patients
          <select value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value || null)}>
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
          <Link className="btn-primary pm-open" to={`/patients/${encodeURIComponent(patient.id)}/monitor`}>
            🩺 Open patient monitor
            {patient.machineAssignments.length > 0 &&
              ` (${patient.machineAssignments.length} machine${patient.machineAssignments.length === 1 ? '' : 's'})`}
          </Link>
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
