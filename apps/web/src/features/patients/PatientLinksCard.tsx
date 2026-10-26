import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { useReconciliationQueue, useResolveReconciliationItem } from '../reconciliation/api';
import { useLinkPatients, usePatientLinks, usePatients, useUnlinkPatient } from './api';

/**
 * Admin: link duplicate IP numbers of one person to a main IP, and delink
 * them. Duplicates are kept as they are and hidden from active lists; every
 * link and delink is recorded in each patient's history timeline.
 */
export function PatientLinksCard() {
  const [search, setSearch] = useState('');
  const { data: patients } = usePatients(search);
  const { data: links } = usePatientLinks();
  const { data: reviews } = useReconciliationQueue('pending');
  const link = useLinkPatients();
  const unlink = useUnlinkPatient();
  const resolve = useResolveReconciliationItem();

  const [picked, setPicked] = useState<Record<string, string>>({}); // id -> label
  const [mainId, setMainId] = useState('');
  const [reason, setReason] = useState('');
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [unlinking, setUnlinking] = useState<{ id: string; label: string } | null>(null);
  const [unlinkReason, setUnlinkReason] = useState('');

  const pickedIds = Object.keys(picked);
  const duplicates = pickedIds.filter((id) => id !== mainId);
  const duplicateReviews = (reviews ?? []).filter((r) => r.kind === 'patient_duplicate' && r.candidates?.length);

  const toggle = (id: string, label: string) => {
    setConfirming(false);
    setPicked((p) => {
      const next = { ...p };
      if (next[id]) delete next[id];
      else next[id] = label;
      return next;
    });
    if (mainId === id) setMainId('');
  };

  const reset = () => {
    setPicked({});
    setMainId('');
    setReason('');
    setReviewId(null);
    setConfirming(false);
  };

  const fromReview = (r: (typeof duplicateReviews)[number]) => {
    const main = r.candidates![0];
    const dupLabel = `${String(r.rawPayload.fullName ?? 'Bedside patient')} (created by ${r.machine.machineCode})`;
    setPicked({ [main.id]: main.label, [r.entityId]: dupLabel });
    setMainId(main.id);
    setReason(`Same patient registered again at the bedside by ${r.machine.machineCode}`);
    setReviewId(r.id);
    setConfirming(false);
    setError('');
  };

  const doLink = async () => {
    setError('');
    setNotice('');
    if (!mainId) return setError('Choose the main IP.');
    if (!duplicates.length) return setError('Tick at least one duplicate IP besides the main IP.');
    if (reason.trim().length < 3) return setError('Say why these IPs are the same patient.');
    if (!confirming) return setConfirming(true);
    try {
      await link.mutateAsync({ mainPatientId: mainId, duplicatePatientIds: duplicates, reason: reason.trim() });
      if (reviewId) await resolve.mutateAsync({ id: reviewId, input: { resolution: `Linked to ${picked[mainId]}: ${reason.trim()}` } });
      setNotice(`Linked ${duplicates.length} IP${duplicates.length === 1 ? '' : 's'} to ${picked[mainId]}.`);
      reset();
    } catch (e) {
      setConfirming(false);
      setError(e instanceof ApiError ? e.message : 'Could not link these IPs.');
    }
  };

  const doUnlink = async () => {
    if (!unlinking) return;
    setError('');
    if (unlinkReason.trim().length < 3) return setError('Say why this IP is being delinked.');
    try {
      await unlink.mutateAsync({ id: unlinking.id, input: { reason: unlinkReason.trim() } });
      setNotice(`Delinked ${unlinking.label}.`);
      setUnlinking(null);
      setUnlinkReason('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delink this IP.');
    }
  };

  return (
    <div className="info-card patient-links">
      <h4 className="form-section-title">🔗 Linked IPs (same patient, duplicate records)</h4>
      <p className="form-hint">
        Tick the IPs that belong to one patient and choose the main IP. The others stay as they are, are hidden from
        patient lists, and their history shows in the main IP&apos;s timeline. Delinking restores them.
      </p>

      {duplicateReviews.length > 0 && (
        <div className="links-reviews">
          <b>Possible duplicates from the bedside</b>
          {duplicateReviews.map((r) => (
            <div key={r.id} className="links-review">
              <span>
                {String(r.rawPayload.fullName ?? 'Bedside patient')} ({r.machine.machineCode}) may be {r.candidates![0].label}
              </span>
              <button type="button" className="link-button" onClick={() => fromReview(r)}>
                Link these
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        className="search-input"
        placeholder="Search by IP number or name…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="links-pick" role="group" aria-label="Patients to link">
        {(patients ?? []).slice(0, 30).map((p) => {
          const label = `${p.ipNumber} · ${p.fullName}`;
          return (
            <label key={p.id} className={`links-pick__row${picked[p.id] ? ' is-picked' : ''}`}>
              <input type="checkbox" checked={!!picked[p.id]} onChange={() => toggle(p.id, label)} />
              <span>{label}</span>
              {p.linkedIpNumbers && p.linkedIpNumbers.length > 0 && <span className="muted">+ {p.linkedIpNumbers.join(', ')}</span>}
            </label>
          );
        })}
      </div>

      {pickedIds.length > 0 && (
        <div className="links-chosen">
          <b>Main IP</b>
          {pickedIds.map((id) => (
            <label key={id} className="links-main">
              <input type="radio" name="main-ip" checked={mainId === id} onChange={() => (setMainId(id), setConfirming(false))} />
              {picked[id]}
            </label>
          ))}
          <label className="links-reason">
            Reason
            <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. registered twice by mistake" />
          </label>
          {confirming && (
            <p className="links-confirm">
              Link {duplicates.map((d) => picked[d]).join(', ')} to <b>{picked[mainId]}</b>? They will be hidden from
              patient lists. Press Link again to confirm.
            </p>
          )}
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={reset}>
              Clear
            </button>
            <button type="button" className="btn-primary" disabled={link.isPending} onClick={() => void doLink()}>
              {confirming ? 'Link — confirm' : 'Link'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
      {notice && <p className="form-hint">✅ {notice}</p>}

      <h5 className="links-subtitle">Current links</h5>
      {links && links.length === 0 && <p className="form-hint">No linked IPs.</p>}
      {links && links.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Main IP</th>
              <th>Linked IP</th>
              <th>Since</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {links.flatMap((g) =>
              g.linkedPatients.map((l) => (
                <tr key={l.id}>
                  <td>
                    {g.ipNumber} · {g.fullName}
                  </td>
                  <td>
                    {l.ipNumber} · {l.fullName}
                  </td>
                  <td>{new Date(l.updatedAt).toLocaleDateString()}</td>
                  <td>
                    <button type="button" className="link-button" onClick={() => setUnlinking({ id: l.id, label: `${l.ipNumber} · ${l.fullName}` })}>
                      Delink
                    </button>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}

      {unlinking && (
        <div className="links-chosen">
          <b>Delink {unlinking.label}</b>
          <label className="links-reason">
            Reason
            <input value={unlinkReason} maxLength={500} onChange={(e) => setUnlinkReason(e.target.value)} placeholder="e.g. linked by mistake" />
          </label>
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={() => setUnlinking(null)}>
              Cancel
            </button>
            <button type="button" className="btn-danger" disabled={unlink.isPending} onClick={() => void doUnlink()}>
              Delink
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
