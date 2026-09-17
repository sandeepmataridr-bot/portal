import { Modal } from '../../components/Modal';
import { usePatient } from './api';
import { PatientTimeline } from './PatientTimeline';

function yesNo(v: boolean) {
  return v ? 'Yes' : 'No';
}

export function PatientDetailsModal({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const { data: patient, isLoading } = usePatient(patientId);

  return (
    <Modal title="Patient Details" onClose={onClose} wide>
      {isLoading || !patient ? (
        <p>Loading…</p>
      ) : (
        <div className="patient-details">
          <h4 className="form-section-title">👤 Patient Identity</h4>
          <div className="detail-grid">
            <div>
              <b>IP Number</b>
              <p>{patient.ipNumber}</p>
            </div>
            <div>
              <b>Name</b>
              <p>{patient.fullName}</p>
            </div>
            <div>
              <b>Age</b>
              <p>{patient.age}</p>
            </div>
            <div>
              <b>Gender</b>
              <p>{patient.gender}</p>
            </div>
            <div>
              <b>Mobile</b>
              <p>{patient.mobile}</p>
            </div>
            <div>
              <b>Emergency Contact</b>
              <p>{patient.emergencyContact}</p>
            </div>
            <div>
              <b>Aadhar</b>
              <p>{patient.aadhar}</p>
            </div>
            <div>
              <b>Address</b>
              <p>{patient.address ?? '—'}</p>
            </div>
          </div>

          <h4 className="form-section-title">🩺 Vitals &amp; Clinical</h4>
          <div className="detail-grid">
            <div>
              <b>Weight (kg)</b>
              <p>{patient.weightKg ?? '—'}</p>
            </div>
            <div>
              <b>Height (cm)</b>
              <p>{patient.heightCm ?? '—'}</p>
            </div>
            <div>
              <b>BP</b>
              <p>
                {patient.bpSystolic ?? '—'}/{patient.bpDiastolic ?? '—'} mmHg
              </p>
            </div>
            <div>
              <b>Heart Rate</b>
              <p>{patient.heartRate ?? '—'} bpm</p>
            </div>
            <div>
              <b>Temperature</b>
              <p>{patient.temperatureF ?? '—'} °F</p>
            </div>
            <div>
              <b>Diagnosis</b>
              <p>{patient.diagnosis ?? '—'}</p>
            </div>
            <div>
              <b>Doctor</b>
              <p>{patient.doctor ? `Dr. ${patient.doctor.name}` : '—'}</p>
            </div>
            <div>
              <b>Discharged</b>
              <p>{yesNo(patient.discharged)}</p>
            </div>
          </div>

          <h4 className="form-section-title">📋 Medical History &amp; Conditions</h4>
          <div className="condition-detail-grid">
            <span className={`badge ${patient.diabetic ? 'badge-yes' : 'badge-no'}`}>🩸 Diabetic: {yesNo(patient.diabetic)}</span>
            <span className={`badge ${patient.hypertensive ? 'badge-yes' : 'badge-no'}`}>
              💓 Hypertensive: {yesNo(patient.hypertensive)}
            </span>
            <span className={`badge ${patient.cva ? 'badge-yes' : 'badge-no'}`}>🧠 CVA: {yesNo(patient.cva)}</span>
            <span className={`badge ${patient.cad ? 'badge-yes' : 'badge-no'}`}>❤️ CAD: {yesNo(patient.cad)}</span>
            <span className={`badge ${patient.seizures ? 'badge-yes' : 'badge-no'}`}>⚡ Seizures: {yesNo(patient.seizures)}</span>
            <span className={`badge ${patient.thyroid ? 'badge-yes' : 'badge-no'}`}>🦋 Thyroid: {yesNo(patient.thyroid)}</span>
            <span className="badge badge-no">➕ Others: {patient.othersText ?? '—'}</span>
          </div>

          {patient.discharged && patient.dischargeDate ? (
            <>
              <h4 className="form-section-title">🏥 Discharge Information</h4>
              <div className="detail-grid">
                <div>
                  <b>Discharge Date</b>
                  <p>{new Date(patient.dischargeDate).toLocaleDateString()}</p>
                </div>
                <div>
                  <b>Remarks</b>
                  <p>{patient.dischargeRemarks ?? '—'}</p>
                </div>
              </div>
            </>
          ) : null}

          {patient.insured ? (
            <>
              <h4 className="form-section-title">🛡️ Insurance Details</h4>
              <div className="detail-grid">
                <div>
                  <b>Claim Status</b>
                  <p>{patient.insuranceClaims[0]?.status ?? 'No claim'}</p>
                </div>
                <div>
                  <b>Remarks</b>
                  <p>{patient.insuranceClaims[0]?.remarks ?? '—'}</p>
                </div>
              </div>
            </>
          ) : null}

          {patient.machineAssignments.length > 0 ? (
            <>
              <h4 className="form-section-title">🖥️ Assigned Machines</h4>
              <div className="detail-grid">
                {patient.machineAssignments.map((a) => (
                  <div key={a.id}>
                    <b>{a.machine.machineType}</b>
                    <p>{a.machine.machineCode}</p>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          <h4 className="form-section-title">📜 History Timeline</h4>
          <PatientTimeline entries={patient.history} />
        </div>
      )}
    </Modal>
  );
}
