import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  AlertNotFound,
  AssociationMethod,
  ScenarioCursor,
  SimClock,
  VigilEngine,
  WallClock,
  MonitorHub,
  HISTORY_S,
  NUMERIC_STEP_S,
  SIGNALS,
  SignalKind,
  buildAck,
  describeMode,
  frames,
  listScenarios,
  loadBundledRules,
  loadScenario,
  loadVigilConfig,
  parseOru,
  setupScenario,
  type CompiledRule,
  type Scenario,
  type VigilConfig,
} from '@infusion/vigil';
import {
  VIGIL_MACHINE_TYPES,
  VIGIL_SPEEDS,
  VIGIL_THERAPY,
  VIGIL_WINDOWS,
  isVigilMachineType,
  type VigilControllerState,
  type VigilIngestInput,
  type VigilIngestResult,
  type VigilMode,
  type VigilState,
} from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { VigilAuditService } from './vigil-audit.service.js';

/** How often LIVE mode re-reads patient↔machine assignments (tag/untag/confirm elsewhere). */
const ASSOCIATION_SYNC_MS = 10_000;
/** TEST-mode playback timer resolution. */
const PLAYBACK_MS = 100;
/** How often LIVE mode deletes stored device messages older than VIGIL_HISTORY_DAYS. */
const HISTORY_PRUNE_MS = 6 * 3600_000;
/** Stored messages replayed per database read at start-up. */
const REPLAY_BATCH = 2000;

interface TestRun {
  scenario: Scenario;
  clock: SimClock;
  cursor: ScenarioCursor;
  /** wall-clock ms and simulated seconds at the last speed change */
  anchorWall: number;
  anchorT: number;
}

/**
 * Vigil ECMO monitoring (docs/vigil/, ADR-006). Runs the TypeScript Vigil
 * engine in-process, in exactly one operating mode chosen at start-up
 * (ADR-005):
 *
 * - TEST: a simulated patient scenario plays through simulated device
 *   drivers on a simulated clock; staff can switch scenario and speed.
 *   Machine ingest is refused. Alerts are tagged TEST.
 * - LIVE: registered ECMO machines push HL7 PCD-01 messages to
 *   POST /vigil/ingest. Associations come from active patient↔machine
 *   assignments; rules run on a machine's data only after a clinician
 *   confirms the association in the central station.
 *
 * Node's event loop serializes every engine access, so there is no locking.
 */
@Injectable()
export class VigilService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VigilService.name);
  private cfg: VigilConfig | null = null;
  private configError = '';
  private rules: { safety: CompiledRule[]; core: CompiledRule[] } = { safety: [], core: [] };
  private engine: VigilEngine | null = null;
  private hub: MonitorHub | null = null;
  private runId = 0;

  // TEST mode
  private run: TestRun | null = null;
  private scenarioName = '';
  private speed = 60;
  private runError = '';
  private playbackTimer: NodeJS.Timeout | null = null;

  // LIVE mode
  private tickTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  /** Per machine code: device time of the last stored message, and the last alarm-flag/setting values seen. */
  private readonly stored = new Map<string, { t: number; flags: Map<string, number> }>();
  private readonly machineIds = new Map<string, string>(); // machineCode -> machine id
  private readonly patientLabels = new Map<string, string>(); // patient id -> "Name (IP no.)"

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: VigilAuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      this.cfg = loadVigilConfig();
      this.rules = loadBundledRules();
    } catch (e) {
      // Vigil refuses to start on an incomplete/invalid configuration
      // (ADR-005) — but only Vigil: the rest of the platform keeps running.
      this.configError = e instanceof Error ? e.message : String(e);
      this.logger.error(`Vigil disabled: ${this.configError}`);
      return;
    }
    for (const line of describeMode(this.cfg)) this.logger.log(line);
    if (this.cfg.liveMode) {
      await this.startLive();
    } else {
      this.scenarioName = this.cfg.scenario;
      this.speed = this.cfg.speed;
      if (this.cfg.autostart) this.startTest(this.scenarioName, this.speed);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopTimers();
    if (this.engine) this.ledger.append(this.mode, 'run_end', { mode: this.mode, stopped: true, stats: this.stats() });
    await this.ledger.flush();
  }

  get mode(): VigilMode {
    return this.cfg?.liveMode ? 'live' : 'test';
  }

  private stopTimers(): void {
    for (const t of [this.playbackTimer, this.tickTimer, this.syncTimer, this.pruneTimer]) if (t) clearInterval(t);
    this.playbackTimer = this.tickTimer = this.syncTimer = this.pruneTimer = null;
  }

  private stats(): Record<string, number> {
    return Object.fromEntries(this.engine?.stats ?? []);
  }

  private newEngine(liveMode: boolean, clock: SimClock | WallClock): VigilEngine {
    const cfg = this.cfg!;
    const mode: VigilMode = liveMode ? 'live' : 'test';
    return new VigilEngine({
      liveMode,
      tenantId: cfg.tenantId,
      unitId: cfg.unitId,
      nodeId: cfg.nodeId,
      clock,
      safetyRules: this.rules.safety,
      coreRules: this.rules.core,
      codeMaps: cfg.codeMaps,
      audit: (kind, data) => this.ledger.append(mode, kind, data),
    });
  }

  // ── TEST mode ────────────────────────────────────────────────────────────

  private controllerState(): VigilControllerState | null {
    if (!this.cfg || this.cfg.liveMode) return null;
    return {
      scenario: this.scenarioName,
      speed: this.speed,
      speeds: [...VIGIL_SPEEDS],
      scenarios: listScenarios(),
      error: this.runError,
      running: this.run !== null && !this.run.cursor.done,
    };
  }

  private requireTest(): void {
    if (!this.cfg) throw new ServiceUnavailableException(this.configError || 'Vigil is not running');
    if (this.cfg.liveMode) {
      throw new ForbiddenException('Scenario control is only available in TEST mode (VIGIL_LIVE_MODE=false)');
    }
  }

  /** Starts (or restarts) a scenario. */
  startTest(scenarioName?: string, speed?: number): VigilControllerState {
    this.requireTest();
    const name = scenarioName ?? this.scenarioName;
    let scenario: Scenario;
    try {
      scenario = loadScenario(name);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
    this.finishTest(true);
    this.scenarioName = name;
    if (speed !== undefined) this.speed = speed;
    this.runError = '';

    const clock = new SimClock(0.0);
    const engine = this.newEngine(false, clock);
    this.runId += 1;
    this.engine = engine;
    this.hub = new MonitorHub(engine, { runId: this.runId, scenario });
    this.ledger.append('test', 'run_start', {
      mode: 'test',
      scenario: scenario.name,
      rules: engine.rules.map((r) => r.key),
    });
    setupScenario(engine, scenario);
    const cursor = new ScenarioCursor(engine, scenario, clock, frames(scenario), this.cfg!.tickSeconds);
    this.run = { scenario, clock, cursor, anchorWall: Date.now(), anchorT: 0 };
    this.playbackTimer = setInterval(() => this.advanceTest(), PLAYBACK_MS);
    this.advanceTest();
    return this.controllerState()!;
  }

  setSpeed(speed: number): VigilControllerState {
    this.requireTest();
    if (this.run) {
      this.run.anchorT = this.run.clock.now();
      this.run.anchorWall = Date.now();
    }
    this.speed = speed;
    return this.controllerState()!;
  }

  private advanceTest(): void {
    const run = this.run;
    if (!run) return;
    try {
      const target = run.anchorT + ((Date.now() - run.anchorWall) / 1000) * this.speed;
      run.cursor.advanceTo(target);
      if (run.cursor.done) this.finishTest(false);
    } catch (e) {
      this.runError = e instanceof Error ? e.message : String(e);
      this.logger.error(`scenario ${run.scenario.name} failed: ${this.runError}`);
      this.finishTest(true);
    }
  }

  private finishTest(stopped: boolean): void {
    if (this.playbackTimer) clearInterval(this.playbackTimer);
    this.playbackTimer = null;
    if (!this.run || !this.hub || this.hub.finished) return;
    this.hub.finished = true;
    this.hub.stopped = stopped;
    this.ledger.append('test', 'run_end', {
      mode: 'test',
      scenario: this.run.scenario.name,
      stopped,
      stats: this.stats(),
    });
  }

  // ── LIVE mode ────────────────────────────────────────────────────────────

  private async startLive(): Promise<void> {
    const engine = this.newEngine(true, new WallClock());
    this.runId += 1;
    this.engine = engine;
    this.hub = new MonitorHub(engine, {
      runId: this.runId,
      directory: {
        machineIdFor: (deviceId) => this.machineIds.get(deviceId) ?? null,
        patientLabelFor: (encounterId) => this.patientLabels.get(encounterId) ?? null,
      },
    });
    this.ledger.append('live', 'run_start', { mode: 'live', rules: engine.rules.map((r) => r.key) });
    // Before any association exists: the replayed data rebuilds the charts but reaches no rule.
    try {
      await this.replayHistory(engine);
    } catch (e) {
      this.logger.error(`history replay failed: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await this.syncAssociations();
    } catch (e) {
      this.logger.error(`initial association sync failed: ${e instanceof Error ? e.message : e}`);
    }
    this.tickTimer = setInterval(() => {
      try {
        engine.tick(engine.clock.now());
      } catch (e) {
        this.logger.error(`rule tick failed: ${e instanceof Error ? e.message : e}`);
      }
    }, this.cfg!.tickSeconds * 1000);
    this.syncTimer = setInterval(() => {
      this.syncAssociations().catch((e: unknown) =>
        this.logger.error(`association sync failed: ${e instanceof Error ? e.message : e}`),
      );
    }, ASSOCIATION_SYNC_MS);
    const prune = () =>
      this.pruneHistory().catch((e: unknown) => this.logger.error(`history clean-up failed: ${e instanceof Error ? e.message : e}`));
    void prune();
    this.pruneTimer = setInterval(prune, HISTORY_PRUNE_MS);
  }

  /** Replays the stored device messages of the last HISTORY_S (the charts' span) into a new LIVE engine. */
  private async replayHistory(engine: VigilEngine): Promise<void> {
    const since = new Date(Date.now() - HISTORY_S * 1000);
    let cursor: bigint | null = null;
    let count = 0;
    for (;;) {
      const rows: { id: bigint; machineCode: string; driver: string; frame: string }[] = await this.prisma.vigilFrame.findMany({
        where: { receivedAt: { gte: since }, ...(cursor === null ? {} : { id: { gt: cursor } }) },
        orderBy: { id: 'asc' },
        take: REPLAY_BATCH,
        select: { id: true, machineCode: true, driver: true, frame: true },
      });
      for (const r of rows) {
        try {
          this.remember(r.machineCode, engine.receive(r.driver, r.frame, { deviceId: r.machineCode }));
          count += 1;
        } catch (e) {
          this.logger.warn(`stored message ${r.id} not replayed: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (rows.length < REPLAY_BATCH) break;
      cursor = rows[rows.length - 1].id;
    }
    if (count) this.logger.log(`history: ${count} stored device messages replayed into the charts`);
  }

  private async pruneHistory(): Promise<void> {
    const before = new Date(Date.now() - this.cfg!.historyDays * 86_400_000);
    const { count } = await this.prisma.vigilFrame.deleteMany({ where: { receivedAt: { lt: before } } });
    if (count) this.logger.log(`history: ${count} device messages older than ${this.cfg!.historyDays} days deleted`);
  }

  /**
   * Whether an accepted message is stored: one every NUMERIC_STEP_S per machine (the charts'
   * resolution), and every one in which an alarm flag or a setting changed, so no change is lost.
   * Also records what was seen, for the next decision.
   */
  private remember(machineCode: string, envs: { validTime: number; payload: { code: string; value: number } }[]): boolean {
    const m = this.stored.get(machineCode) ?? { t: -Infinity, flags: new Map<string, number>() };
    this.stored.set(machineCode, m);
    let store = false;
    let newest = -Infinity;
    for (const env of envs) {
      newest = Math.max(newest, env.validTime);
      const sig = SIGNALS[env.payload.code];
      if (!sig || (sig.kind !== SignalKind.STATUS && sig.kind !== SignalKind.SETTING)) continue;
      if (m.flags.get(env.payload.code) !== env.payload.value) store = true;
      m.flags.set(env.payload.code, env.payload.value);
    }
    if (newest - m.t >= NUMERIC_STEP_S) store = true;
    if (store && newest > -Infinity) m.t = Math.max(m.t, newest);
    return store;
  }

  /** Coalesces concurrent sync requests into one database read. */
  private syncAssociations(): Promise<void> {
    this.syncing ??= this.doSyncAssociations().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  /**
   * Mirrors active patient↔machine assignments (ECMO, EBOO, monitors) into the engine: new ones are
   * added, ended ones end (resolving their alerts), and confirmations made
   * through the central station are applied.
   */
  private async doSyncAssociations(): Promise<void> {
    const engine = this.engine;
    if (!engine || !engine.liveMode) return;
    const vigilTypes = { in: [...VIGIL_MACHINE_TYPES] };
    const machines = await this.prisma.machine.findMany({ where: { machineType: vigilTypes }, select: { id: true, machineCode: true } });
    this.machineIds.clear();
    for (const m of machines) this.machineIds.set(m.machineCode, m.id);
    const active = await this.prisma.patientMachineAssignment.findMany({
      where: { unassignedAt: null, machine: { machineType: vigilTypes } },
      include: {
        machine: { select: { machineCode: true, machineType: true } },
        patient: { select: { id: true, fullName: true, ipNumber: true } },
        vigilConfirmedBy: { select: { loginId: true } },
      },
      orderBy: { assignedAt: 'asc' },
    });
    const now = engine.clock.now();
    const activeIds = new Set(active.map((a) => a.id));

    for (const assoc of engine.associations.all()) {
      if (assoc.end === null && !activeIds.has(assoc.associationId)) {
        engine.endAssociation(assoc.associationId, now, 'machine unassigned from the patient');
      }
    }
    for (const a of active) {
      this.patientLabels.set(a.patient.id, a.patient.ipNumber ? `${a.patient.fullName} (${a.patient.ipNumber})` : a.patient.fullName);
      const confirmedBy = a.vigilConfirmedAt ? `${a.vigilConfirmedBy?.loginId ?? 'unknown'} (central station)` : '';
      const existing = engine.associations.get(a.id);
      if (!existing) {
        const start = a.assignedAt.getTime() / 1000;
        const episodeId = `ep-${a.id}`;
        engine.addAssociation(
          {
            associationId: a.id,
            deviceId: a.machine.machineCode,
            encounterId: a.patient.id,
            therapyEpisodeId: episodeId,
            start,
            end: null,
            method: AssociationMethod.ADT_ONLY,
            confirmed: a.vigilConfirmedAt !== null,
            confirmedBy,
          },
          { episodeId, encounterId: a.patient.id, therapy: therapyOf(a.machine.machineType), start, end: null, attributes: {} },
        );
      } else if (!existing.confirmed && a.vigilConfirmedAt) {
        engine.confirmAssociation(a.id, confirmedBy);
      }
    }
  }

  /** LIVE-mode device data from an authenticated monitoring machine (ECMO, EBOO, patient monitors). */
  async ingest(machineId: string, input: VigilIngestInput): Promise<VigilIngestResult> {
    if (!this.cfg) throw new ServiceUnavailableException(this.configError || 'Vigil is not running');
    if (!this.cfg.liveMode || !this.engine) {
      // ADR-005: the engine never mixes real device data into a TEST run.
      throw new ForbiddenException('Vigil is in TEST mode; machine data is refused (VIGIL_LIVE_MODE=false)');
    }
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId } });
    if (!machine) throw new NotFoundException('Machine not found');
    if (!isVigilMachineType(machine.machineType)) throw new ForbiddenException('Only monitoring machines (ECMO, EBOO, patient monitors) send Vigil data');
    if (!this.machineIds.has(machine.machineCode)) await this.syncAssociations();

    const acks: string[] = [];
    const keep: string[] = [];
    let accepted = 0;
    for (const frame of input.frames) {
      try {
        parseOru(frame); // reject malformed messages with an AE before they reach the engine
        const envs = this.engine.receive(input.driver, frame, { deviceId: machine.machineCode });
        if (this.remember(machine.machineCode, envs)) keep.push(frame);
        acks.push(buildAck(frame, 'AA'));
        accepted += 1;
      } catch (e) {
        acks.push(buildAck(frame, 'AE', e instanceof Error ? e.message : String(e)));
      }
    }
    if (keep.length) {
      // Kept for the charts after a restart. A failed write never refuses data the engine already has.
      await this.prisma.vigilFrame
        .createMany({ data: keep.map((frame) => ({ machineId, machineCode: machine.machineCode, driver: input.driver, frame })) })
        .catch((e: unknown) => this.logger.error(`device messages not stored: ${e instanceof Error ? e.message : e}`));
    }
    return { accepted, rejected: input.frames.length - accepted, acks };
  }

  // ── shared actions ───────────────────────────────────────────────────────

  private requireEngine(): VigilEngine {
    if (!this.engine) throw new ServiceUnavailableException(this.configError || 'Vigil is not running');
    return this.engine;
  }

  acknowledge(alertRef: string, actor: AuthenticatedUser): void {
    const engine = this.requireEngine();
    try {
      engine.acknowledge(alertRef, actor.loginId);
    } catch (e) {
      if (e instanceof AlertNotFound) throw new ConflictException(e.message);
      throw e;
    }
  }

  /**
   * Confirms that a machine really is on its tagged patient, so therapy rules
   * start running on its data. LIVE: persisted on the assignment and
   * audited. TEST: applied to the simulated association only.
   */
  async confirmAssociation(associationId: string, actor: AuthenticatedUser): Promise<void> {
    const engine = this.requireEngine();
    const by = `${actor.loginId} (central station)`;
    if (!engine.liveMode) {
      const assoc = engine.associations.get(associationId);
      if (!assoc || assoc.end !== null) throw new NotFoundException('No open association with that id');
      if (assoc.confirmed) throw new ConflictException('Association is already confirmed');
      engine.confirmAssociation(associationId, by);
      return;
    }
    const assignment = await this.prisma.patientMachineAssignment.findUnique({
      where: { id: associationId },
      include: { machine: true },
    });
    if (!assignment || assignment.unassignedAt || !isVigilMachineType(assignment.machine.machineType)) {
      throw new NotFoundException('No active monitoring assignment with that id');
    }
    if (assignment.vigilConfirmedAt) throw new ConflictException('Association is already confirmed');
    await this.prisma.patientMachineAssignment.update({
      where: { id: associationId },
      data: { vigilConfirmedAt: new Date(), vigilConfirmedById: actor.id },
    });
    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'VIGIL_ASSOCIATION_CONFIRMED',
      entityTable: 'patient_machine_assignments',
      entityId: associationId,
      after: { machineId: assignment.machineId, patientId: assignment.patientId },
    });
    await this.syncAssociations();
  }

  state(window: number): VigilState {
    const controller = this.controllerState();
    if (!this.engine || !this.hub) {
      return { ready: false, mode: this.mode, controller, windows: [...VIGIL_WINDOWS], error: this.configError };
    }
    return this.hub.snapshot(window, [...VIGIL_WINDOWS], controller, this.mode);
  }

  verifyAudit() {
    return this.ledger.verify(this.mode);
  }
}

/** The Vigil therapy a machine type's data belongs to (ECMO rules run only on ECMO). */
function therapyOf(machineType: string): string {
  return isVigilMachineType(machineType) ? VIGIL_THERAPY[machineType] : 'ECMO';
}
