import { Modal } from '../../components/Modal';
import { useDoctorHistory } from './api';

interface AuditEntry {
  id: string;
  action: string;
  entityTable: string;
  createdAt: string;
}

export function DoctorHistoryModal({ doctorId, doctorName, onClose }: { doctorId: string; doctorName: string; onClose: () => void }) {
  const { data: history, isLoading } = useDoctorHistory(doctorId);
  const entries = (history as AuditEntry[] | undefined) ?? [];

  return (
    <Modal title={`📜 Doctor History: ${doctorName}`} onClose={onClose} wide>
      {isLoading && <p>Loading...</p>}
      {!isLoading && entries.length === 0 && <p className="timeline-empty">No activity recorded.</p>}
      <div className="timeline">
        {entries.map((e) => (
          <div key={e.id} className="timeline-entry">
            <div className="timeline-entry__header">
              <span className="timeline-badge badge-default">{e.action}</span>
              <span className="timeline-entry__date">{new Date(e.createdAt).toLocaleString()}</span>
            </div>
            <p className="timeline-entry__meta">Table: {e.entityTable}</p>
          </div>
        ))}
      </div>
    </Modal>
  );
}
