import { useState } from 'react';
import { ApiError, apiDownload } from '../../lib/api';

type Period = 'stay' | '24h' | '7d' | 'custom';

/**
 * Superuser only: one patient's complete log as a ZIP of spreadsheet files (CSV): the patient
 * and their timeline, the portal's alerts, and a folder per machine they were on with every
 * reading and the machine's own logs, for the time it was tagged to them.
 */
export function DownloadPatientLog({ patientId, patientName }: { patientId: string; patientName: string }) {
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<Period>('stay');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const download = async () => {
    setError('');
    const q = new URLSearchParams();
    const now = Date.now();
    if (period === '24h') q.set('from', new Date(now - 24 * 3600_000).toISOString());
    if (period === '7d') q.set('from', new Date(now - 7 * 24 * 3600_000).toISOString());
    if (period === 'custom') {
      if (!from) return setError('Choose the start date and time.');
      q.set('from', new Date(from).toISOString());
      if (to) q.set('to', new Date(to).toISOString());
    }
    setBusy(true);
    try {
      await apiDownload(`/vigil/patients/${encodeURIComponent(patientId)}/log-export${q.size ? `?${q}` : ''}`, `patient-log-${patientName}.zip`);
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The download did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        ⬇ Download patient log
      </button>
    );
  }
  return (
    <div className="info-card patient-form download-log">
      <h4 className="form-section-title">⬇ Download patient log</h4>
      <p className="form-hint">
        A ZIP of spreadsheet files: the patient, their timeline, the portal&apos;s alerts, and for every machine they were on, each
        reading and the machine&apos;s own treatment, alarm and system logs.
      </p>
      <label>
        Period
        <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
          <option value="stay">Whole stay</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="custom">Choose dates</option>
        </select>
      </label>
      {period === 'custom' && (
        <div className="form-row form-row--4">
          <label>
            From
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To (empty: now)
            <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={() => void download()} disabled={busy}>
          {busy ? 'Preparing…' : 'Download'}
        </button>
      </div>
    </div>
  );
}
