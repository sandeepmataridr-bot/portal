/**
 * The Vigil engine (reference: edge/node.py EdgeNode):
 *
 *     driver -> normalizer -> SQI -> rules (safety floor + core) -> alert book
 *
 *     receive(driverId, frame)   ingest one device frame
 *     tick(now)                  evaluate rules; returns alert transitions
 *
 * Single-threaded and synchronous: callers serialize access (Node's event
 * loop does this for the API). Mode guards from ADR-005 are enforced here.
 */
import { AlertBook, type Transition } from './alerts.js';
import { CODE_SYSTEM, SIGNALS } from './codes.js';
import { Origin, type DeviceAssociation, type Envelope, type TherapyEpisode } from './contracts.js';
import { DriverHost, Hl7Pcd01Driver, ModeViolation, SimEcmoDriver } from './drivers.js';
import { AssociationRegistry, Normalizer, SignalQuality } from './pipeline.js';
import type { CompiledRule } from './rules/compiler.js';
import { CdsRuntime, SafetyEngine, type RuleHost } from './rules/host.js';
import { newEventId, type Clock } from './time.js';

export type AuditSink = (kind: string, data: Record<string, unknown>) => void;

export interface EngineOptions {
  liveMode: boolean;
  tenantId: string;
  unitId: string;
  nodeId: string;
  clock: Clock;
  safetyRules: CompiledRule[];
  coreRules: CompiledRule[];
  audit?: AuditSink;
  /** site-specific vendor code maps, merged over the bundled ones */
  codeMaps?: Record<string, Record<string, string>>;
}

export interface ReceiveOptions {
  /**
   * Attribute every sample to this device, whatever the frame says. LIVE
   * ingest sets it to the authenticated machine so one machine can never
   * report data into another machine's patient.
   */
  deviceId?: string;
}

export class VigilEngine {
  readonly liveMode: boolean;
  readonly tenantId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly clock: Clock;
  readonly stats = new Map<string, number>();
  readonly drivers: DriverHost;
  readonly normalizer: Normalizer;
  readonly sqi = new SignalQuality();
  readonly associations = new AssociationRegistry();
  readonly safety: SafetyEngine;
  readonly cds: CdsRuntime;
  readonly alerts: AlertBook;
  readonly transitionListeners: ((tr: Transition) => void)[] = [];
  readonly observationListeners: ((env: Envelope) => void)[] = [];
  private readonly audit?: AuditSink;

  constructor(opts: EngineOptions) {
    if (opts.liveMode && opts.clock.simulated) throw new ModeViolation('LIVE mode requires the wall clock');
    this.liveMode = opts.liveMode;
    this.tenantId = opts.tenantId;
    this.unitId = opts.unitId;
    this.nodeId = opts.nodeId;
    this.clock = opts.clock;
    this.audit = opts.audit;
    this.drivers = new DriverHost(opts.liveMode, (driverId, error) => this.driverFault(driverId, error));
    this.drivers.register(() => new Hl7Pcd01Driver());
    if (!opts.liveMode) this.drivers.register(() => new SimEcmoDriver());
    this.normalizer = Normalizer.withDefaults(opts.codeMaps);
    this.safety = new SafetyEngine(opts.safetyRules);
    this.cds = new CdsRuntime(opts.coreRules);
    this.alerts = new AlertBook(!opts.liveMode);
  }

  get rules(): CompiledRule[] {
    return [...this.safety.rules, ...this.cds.rules];
  }

  stat(key: string): number {
    return this.stats.get(key) ?? 0;
  }

  private bump(key: string): void {
    this.stats.set(key, this.stat(key) + 1);
  }

  private engines(): [Origin, RuleHost][] {
    return [
      [Origin.EDGE_SAFETY_FLOOR, this.safety],
      [Origin.CORE, this.cds],
    ];
  }

  // -- associations ------------------------------------------------------
  addAssociation(assoc: DeviceAssociation, episode: TherapyEpisode): void {
    this.associations.addEpisode(episode);
    this.associations.add(assoc);
    this.writeAudit('association', {
      association_id: assoc.associationId,
      device_id: assoc.deviceId,
      encounter_id: assoc.encounterId,
      therapy: episode.therapy,
      confirmed: assoc.confirmed,
      confirmed_by: assoc.confirmedBy,
    });
    if (assoc.confirmed) this.open(assoc);
  }

  confirmAssociation(associationId: string, by: string): DeviceAssociation {
    const assoc = this.associations.confirm(associationId, by);
    this.writeAudit('association_confirmed', { association_id: associationId, by });
    this.open(assoc);
    return assoc;
  }

  /**
   * Ends an association (e.g. the machine was untagged from the patient).
   * When the encounter has no confirmed association left, its rules stop and
   * its alerts are resolved; nothing would ever clear them otherwise.
   */
  endAssociation(associationId: string, at: number, reason: string): Transition[] {
    const assoc = this.associations.end(associationId, at);
    this.writeAudit('association_ended', { association_id: associationId, encounter_id: assoc.encounterId, reason });
    if (this.associations.hasOpenConfirmed(assoc.encounterId)) return [];
    for (const [, engine] of this.engines()) engine.closeEncounter(assoc.encounterId);
    const out = this.alerts.resolveEncounter(assoc.encounterId, at, reason);
    for (const tr of out) this.announce(tr);
    return out;
  }

  private open(assoc: DeviceAssociation): void {
    const therapies = this.associations.therapiesFor(assoc.encounterId);
    for (const [, engine] of this.engines()) engine.openEncounter(assoc.encounterId, therapies, assoc.start);
  }

  // -- data path ---------------------------------------------------------
  receive(driverId: string, frame: string, opts: ReceiveOptions = {}): Envelope[] {
    const out: Envelope[] = [];
    const driver = this.drivers.driver(driverId);
    for (const decoded of this.drivers.decode(driverId, frame)) {
      const raw = opts.deviceId ? { ...decoded, deviceId: opts.deviceId } : decoded;
      const assoc = this.associations.activeForDevice(raw.deviceId, raw.deviceTime);
      const obs = this.normalizer.normalize(driverId, raw, assoc ? assoc.associationId : '');
      if (obs.codeSystem === CODE_SYSTEM) {
        const [sqi, flags] = this.sqi.assess(`${raw.deviceId}\u0000${obs.code}`, SIGNALS[obs.code], raw.deviceTime, obs.value);
        obs.sqi = sqi;
        obs.flags.push(...flags);
      }
      if (!assoc) obs.flags.push('UNASSOCIATED');
      else if (!assoc.confirmed) obs.flags.push('UNCONFIRMED');
      for (const flag of obs.flags) this.bump(`flag:${flag}`);
      const env: Envelope = {
        eventId: newEventId(),
        tenantId: this.tenantId,
        unitId: this.unitId,
        sourceId: `spiffe://${this.tenantId}/${this.unitId}/device/${raw.deviceId}`,
        deviceId: raw.deviceId,
        validTime: raw.deviceTime,
        recordedTime: this.clock.now(),
        clockOffsetUs: 0,
        schema: 'vigil.v1.Observation',
        payload: obs,
        provenance: { driverId: driver.driverId, driverVersion: driver.version, edgeNodeId: this.nodeId, lateArrival: false },
        testMode: !this.liveMode,
      };
      this.bump('observations');
      this.publish(env);
      out.push(env);
    }
    return out;
  }

  private publish(env: Envelope): void {
    this.toRules(env);
    for (const fn of this.observationListeners) fn(env);
  }

  private toRules(env: Envelope): void {
    if (env.testMode !== !this.liveMode) throw new ModeViolation('envelope from the other operating mode');
    const obs = env.payload;
    if (obs.codeSystem !== CODE_SYSTEM) return;
    const assoc = this.associations.get(obs.associationId);
    if (!assoc || !assoc.confirmed) return;
    for (const [, engine] of this.engines()) {
      engine.observe(assoc.encounterId, obs.code, env.validTime, obs.value, obs.sqi, obs.flags);
    }
  }

  // -- evaluation --------------------------------------------------------
  tick(now: number): Transition[] {
    const out: Transition[] = [];
    for (const [origin, engine] of this.engines()) {
      for (const ev of engine.tick(now)) {
        const tr = this.alerts.apply(ev, origin);
        if (tr) {
          this.announce(tr);
          out.push(tr);
        }
      }
    }
    return out;
  }

  acknowledge(ref: string, by: string): Transition {
    const tr = this.alerts.acknowledge(ref, by, this.clock.now());
    this.announce(tr);
    return tr;
  }

  private announce(tr: Transition): void {
    this.bump(`alerts_${tr.kind}`);
    const a = tr.alert;
    this.writeAudit(`alert_${tr.kind}`, {
      alert_id: a.alertId,
      rule: a.problemKey,
      rule_version: a.findings[0].rule.ruleVersion,
      encounter_id: a.encounterId,
      priority: a.priority,
      origin: a.origin,
      valid_time: tr.at,
      explanation: a.explanation,
      test_mode: a.testMode,
      acknowledged_by: a.acknowledgedBy,
      ...(tr.reason ? { reason: tr.reason } : {}),
    });
    for (const fn of this.transitionListeners) fn(tr);
  }

  private driverFault(driverId: string, error: unknown): void {
    this.bump('driver_faults');
    this.writeAudit('driver_fault', { driver_id: driverId, error: String(error instanceof Error ? error.message : error).slice(0, 200) });
  }

  private writeAudit(kind: string, data: Record<string, unknown>): void {
    this.audit?.(kind, { mode: this.liveMode ? 'live' : 'test', ...data });
  }
}
