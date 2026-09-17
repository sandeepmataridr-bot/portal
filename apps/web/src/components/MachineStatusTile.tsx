import { useFleetStatus } from '../features/machines/api';
import { StatTile } from './StatTile';

/**
 * The "Machines Online: M/N" tile the plan calls for on every role
 * dashboard, not just a dedicated fleet screen — sourced from the same
 * live fleet-status endpoint the admin fleet view uses.
 */
export function MachineStatusTile() {
  const { data } = useFleetStatus();
  if (!data) return <StatTile label="Machines Online" value="…" tone="info" />;
  return (
    <StatTile
      label="Machines Online"
      value={`${data.connectedMachines} / ${data.totalMachines}`}
      tone={data.connectedMachines > 0 ? 'success' : 'info'}
    />
  );
}
