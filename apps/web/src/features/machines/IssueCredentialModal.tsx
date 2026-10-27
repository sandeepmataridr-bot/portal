import { ConfirmTypedModal } from '../../components/ConfirmTypedModal';
import { useIssueMachineCredential } from './api';

/**
 * Issuing a credential revokes the machine's current one at once, so the
 * machine is cut off until the new ID and token are entered on it. The
 * superuser must type CONFIRM first; a click alone never does it.
 */
export function IssueCredentialModal({
  machine,
  onIssued,
  onClose,
}: {
  machine: { id: string; machineCode: string; sendingData: boolean };
  onIssued: (credential: { machineId: string; machineCode: string; token: string }) => void;
  onClose: () => void;
}) {
  const issue = useIssueMachineCredential();
  return (
    <ConfirmTypedModal
      title={`🔑 New credential for ${machine.machineCode}`}
      action="Issue new credential"
      busyLabel="Issuing…"
      onConfirm={async () => onIssued(await issue.mutateAsync(machine.id))}
      onClose={onClose}
    >
      <p className="form-error">
        ⚠️ This <strong>replaces {machine.machineCode}&apos;s current token at once</strong>. From that moment the machine is
        refused: its data stops reaching the portal until the new Machine ID and Token are entered on the machine (for an
        ESP32, in its <code>secrets.h</code>, then uploaded again).
      </p>
      {machine.sendingData && (
        <p className="form-error">
          <strong>{machine.machineCode} is sending data right now.</strong> Its connection will be lost.
        </p>
      )}
      <p>Only do this for a new machine, or when the old token is lost or may have been seen by someone else.</p>
    </ConfirmTypedModal>
  );
}
