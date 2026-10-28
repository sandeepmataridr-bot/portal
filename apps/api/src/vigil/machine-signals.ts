import { SIGNAL_ORDER } from '@infusion/vigil';

/**
 * The signals a machine type reports, in the portal's display order: the
 * patient log's readings columns and the superuser's show/hide list.
 */
export function signalsFor(machineType: string): string[] {
  const prefixes: Record<string, string[]> = {
    ECMO: ['ECMO_', 'HU_', 'LAB_', 'LIMIT_', 'BG_'],
    EBOO: ['ECMO_PUMP_SPEED', 'ECMO_BLOOD_FLOW', 'ECMO_BUBBLE_ALARM', 'ECMO_LEVEL_ALARM', 'EBOO_', 'VITAL_HEART_RATE', 'VITAL_SPO2', 'HU_'],
  };
  const want = prefixes[machineType] ?? ['VITAL_'];
  return SIGNAL_ORDER.filter((c) => want.some((p) => c.startsWith(p)));
}
