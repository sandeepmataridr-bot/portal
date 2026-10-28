import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MachineSignalOption } from '@infusion/shared-types';
import { Modal } from '../../components/Modal';
import { ApiError, apiFetch } from '../../lib/api';
import { fmtUnit } from '../vigil/format';
import { signalGroup } from '../vigil/sections';

/**
 * Superuser: which of a machine's values the portal shows (central station, patient page, View
 * Live). Display only: a hidden value is still stored, still in the patient log download and still
 * checked by the alarm rules.
 */
export function MachineValuesModal({ machineId, machineCode, onClose }: { machineId: string; machineCode: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: options, isLoading } = useQuery({
    queryKey: ['machine-signals', machineId],
    queryFn: () => apiFetch<MachineSignalOption[]>(`/vigil/machines/${encodeURIComponent(machineId)}/signals`),
  });
  // The user's changes; until the first one, what the server has.
  const [edits, setEdits] = useState<Set<string> | null>(null);
  const hidden = edits ?? (options ? new Set(options.filter((o) => o.hidden).map((o) => o.code)) : null);
  const save = useMutation({
    mutationFn: (codes: string[]) =>
      apiFetch<MachineSignalOption[]>(`/vigil/machines/${encodeURIComponent(machineId)}/hidden-signals`, {
        method: 'PATCH',
        body: JSON.stringify({ hidden: codes }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['machine-signals', machineId], data);
      onClose();
    },
  });

  const groups: [string, MachineSignalOption[]][] = [];
  for (const o of options ?? []) {
    const g = signalGroup(o.code);
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(o);
    else groups.push([g, [o]]);
  }
  const toggle = (codes: string[], hide: boolean) => {
    const next = new Set(hidden);
    for (const c of codes) {
      if (hide) next.add(c);
      else next.delete(c);
    }
    setEdits(next);
  };
  const shownCount = (options?.length ?? 0) - (hidden?.size ?? 0);

  return (
    <Modal title={`👁 Values shown for ${machineCode}`} onClose={onClose} wide>
      <div className="machine-values">
        <p className="form-hint">
          Tick the values to show on the central station, the patient page and View Live. Hidden values are still stored, still in the
          patient log download, and the alarm rules still check them.
        </p>
        {isLoading || !hidden ? (
          <p className="form-hint">Loading…</p>
        ) : (
          <>
            <p className="machine-values__count">
              {shownCount} of {options!.length} shown
            </p>
            {groups.map(([group, items]) => (
              <fieldset key={group} className="machine-values__group">
                <legend>
                  {group}{' '}
                  <button type="button" className="link-button" onClick={() => toggle(items.map((i) => i.code), false)}>
                    Show all
                  </button>{' '}
                  <button type="button" className="link-button" onClick={() => toggle(items.map((i) => i.code), true)}>
                    Hide all
                  </button>
                </legend>
                {items.map((o) => (
                  <label key={o.code} className="machine-values__item">
                    <input type="checkbox" checked={!hidden.has(o.code)} onChange={(e) => toggle([o.code], !e.target.checked)} />
                    <span>
                      {o.label}
                      {fmtUnit(o.unit) ? <span className="machine-values__unit"> ({fmtUnit(o.unit)})</span> : null}
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
          </>
        )}
        {save.isError && <p className="form-error">{save.error instanceof ApiError ? save.error.message : 'Could not save.'}</p>}
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!hidden || save.isPending} onClick={() => hidden && save.mutate([...hidden])}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
