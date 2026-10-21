/**
 * In-process mirror of docs/vigil/proto/vigil/v1. Field names follow the
 * .proto files (camelCased, as in their JSON mapping), which stay the source
 * of truth. Timestamps are float seconds.
 */
import type { VigilAlertStateName, VigilPriority } from '@infusion/shared-types';

export type Priority = VigilPriority;
export type AlertState = VigilAlertStateName;

export enum Origin {
  EDGE_SAFETY_FLOOR = 'EDGE_SAFETY_FLOOR',
  CORE = 'CORE',
}

export enum AssociationMethod {
  ADT_ONLY = 'ADT_ONLY',
  BARCODE = 'BARCODE',
  NFC = 'NFC',
  SDC_CONTEXT = 'SDC_CONTEXT',
}

export interface Provenance {
  driverId: string;
  driverVersion: string;
  edgeNodeId: string;
  lateArrival: boolean;
}

export interface Observation {
  associationId: string;
  codeSystem: string;
  code: string;
  value: number;
  unitUcum: string;
  rawValue: number;
  rawUnit: string;
  sqi: number;
  flags: string[];
}

export interface Envelope {
  eventId: string;
  tenantId: string;
  unitId: string;
  sourceId: string;
  /** the device the sample came from (last segment of sourceId) */
  deviceId: string;
  validTime: number;
  recordedTime: number;
  clockOffsetUs: number;
  schema: string;
  payload: Observation;
  provenance: Provenance;
  testMode: boolean;
}

export interface DeviceAssociation {
  associationId: string;
  deviceId: string;
  encounterId: string;
  therapyEpisodeId: string;
  start: number;
  end: number | null;
  method: AssociationMethod;
  confirmed: boolean;
  confirmedBy: string;
}

export interface TherapyEpisode {
  episodeId: string;
  encounterId: string;
  therapy: string;
  start: number;
  end: number | null;
  attributes: Record<string, string>;
}

export interface RuleHit {
  ruleId: string;
  ruleVersion: string;
}

export interface Finding {
  rule: RuleHit;
}

export interface Alert {
  alertId: string;
  encounterId: string;
  priority: Priority;
  problemKey: string;
  findings: Finding[];
  state: AlertState;
  explanation: string;
  evidenceEventIds: string[];
  origin: Origin;
  raisedTime: number;
  testMode: boolean;
  resolvedTime: number | null;
  acknowledgedBy: string;
}
