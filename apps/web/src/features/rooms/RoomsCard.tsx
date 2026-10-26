import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { useCreateRoom, useRooms, useUpdateRoom } from './api';

/**
 * Admin: the list of ICU rooms/beds that machines and patients pick from.
 * Rename or deactivate a room (refused while machines or admitted patients
 * are in it); inactive rooms stay listed so they can be reactivated.
 */
export function RoomsCard() {
  const { data: rooms } = useRooms(true);
  const create = useCreateRoom();
  const update = useUpdateRoom();
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save.');
    }
  };

  const add = () =>
    run(async () => {
      if (!name.trim()) throw new ApiError(400, undefined, 'Room name is required');
      await create.mutateAsync({ name: name.trim() });
      setName('');
    });

  return (
    <div className="info-card rooms-card">
      <h4 className="form-section-title">🏥 Rooms</h4>
      <p className="form-hint">
        Machines and patients are placed in these rooms. A machine can only be tagged to a patient in the same room.
      </p>
      <div className="rooms-add">
        <input value={name} maxLength={60} placeholder="e.g. ICU Room 4" onChange={(e) => setName(e.target.value)} />
        <button type="button" className="btn-primary" disabled={create.isPending} onClick={() => void add()}>
          ➕ Add room
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <table className="data-table">
        <thead>
          <tr>
            <th>Room</th>
            <th>Machines</th>
            <th>Patients</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rooms?.map((r) => (
            <tr key={r.id} className={r.active ? undefined : 'is-inactive'}>
              <td>
                {renaming?.id === r.id ? (
                  <input value={renaming.name} maxLength={60} onChange={(e) => setRenaming({ id: r.id, name: e.target.value })} />
                ) : (
                  r.name
                )}
              </td>
              <td>{r.machineCount}</td>
              <td>{r.patientCount}</td>
              <td>
                <span className={`status-badge status-${r.active ? 'active' : 'inactive'}`}>{r.active ? 'Active' : 'Inactive'}</span>
              </td>
              <td>
                {renaming?.id === r.id ? (
                  <>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() =>
                        void run(async () => {
                          await update.mutateAsync({ id: r.id, input: { name: renaming.name.trim() } });
                          setRenaming(null);
                        })
                      }
                    >
                      Save
                    </button>{' '}
                    <button type="button" className="link-button" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="link-button" onClick={() => setRenaming({ id: r.id, name: r.name })}>
                      ✏️ Rename
                    </button>{' '}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => void run(() => update.mutateAsync({ id: r.id, input: { active: !r.active } }))}
                    >
                      {r.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
