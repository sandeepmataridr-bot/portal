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
  buildAck,
  describeMode,
  frames,
  listScenarios,
  loadBundledRules,
  loadScenario,
  loadVigilConfig,
  parseOru,
  parseTs,
  SIGNALS,
  SIGNAL_ORDER,
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
  type MachineHiddenSignalsInput,
  type MachineSignalOption,
} from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { signalsFor } from './machine-signals.js';
import { VigilAuditService } from './vigil-audit.service.js';

/** How often LIVE mode re-reads patient↔machine assignments (tag/untag/confirm elsewhere). */
const ASSOCIATION_SYNC_MS = 10_000;
/** TEST-mode playback timer resolution. */
const PLAYBACK_MS = 100;
/** How often LIVE mode deletes stored device messages older than VIGIL_HISTORY_DAYS. */
const HISTORY_PRUNE_MS = 6 * 3600_000;
/** Stored bundles replayed per database read at start-up. */
const REPLAY_BATCH = 200;
/** Device messages are written to the database in bundles of about this long per machine (or BUNDLE_MAX messages). */
const BUNDLE_MS = 10_000;
const BUNDLE_MAX = 120;
const BUNDLE_CHECK_MS = 2_000;

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
  private flushTimer: NodeJS.Timeout | null = null;
  /** Accepted device messages not yet written, per machine and driver (see queueForStorage). */
  private readonly pending = new Map<string, { machineId: string; machineCode: string; driver: string; frames: string[]; firstAt: Date }>();
  private readonly machineIds = new Map<string, string>(); // machineCode -> machine id
  /** machineCode -> signals the superuser hides for it (display only) */
  private readonly hidden = new Map<string, Set<string>>();
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
    await this.flushStorage(true);         // the last seconds of device messages
    if (this.engine) this.ledger.append(this.mode, 'run_end', { mode: this.mode, stopped: true, stats: this.stats() });
    await this.ledger.flush();
  }

  get mode(): VigilMode {
    return this.cfg?.liveMode ? 'live' : 'test';
  }

  private stopTimers(): void {
    for (const t of [this.playbackTimer, this.tickTimer, this.syncTimer, this.pruneTimer, this.flushTimer]) if (t) clearInterval(t);
    this.playbackTimer = this.tickTimer = this.syncTimer = this.pruneTimer = this.flushTimer = null;
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
    this.flushTimer = setInterval(() => void this.flushStorage(false), BUNDLE_CHECK_MS);
  }

  /**
   * Replays the stored device messages of the last HISTORY_S (the charts' span) into a new LIVE
   * engine. The charts keep one point every NUMERIC_STEP_S, so a message is replayed when it is
   * that much newer than the last one replayed for its machine, when it carries a lab result,
   * and at the end of every bundle (so settings end up as they were): a few hours of
   * once-a-second messages load in seconds.
   */
  private async replayHistory(engine: VigilEngine): Promise<void> {
    const since = new Date(Date.now() - HISTORY_S * 1000);
    const lastReplayed = new Map<string, number>();
    let cursor: bigint | null = null;
    let count = 0;
    for (;;) {
      const rows: { id: bigint; machineCode: string; driver: string; frames: unknown }[] = await this.prisma.vigilFrame.findMany({
        where: { receivedAt: { gte: since }, ...(cursor === null ? {} : { id: { gt: cursor } }) },
        orderBy: { id: 'asc' },
        take: REPLAY_BATCH,
        select: { id: true, machineCode: true, driver: true, frames: true },
      });
      for (const r of rows) {
        const frames = Array.isArray(r.frames) ? (r.frames as string[]) : [];
        frames.forEach((frame, i) => {
          let t = NaN;
          try {
            t = parseTs(frame.split('|')[6] ?? '');
          } catch {
            // no usable MSH-7: replay it
          }
          const prev = lastReplayed.get(r.machineCode);
          const due = !Number.isFinite(t) || prev === undefined || t - prev >= NUMERIC_STEP_S - 0.5;
          if (!due && i < frames.length - 1 && !frame.includes('LAB_')) return;
          try {
            engine.receive(r.driver, frame, { deviceId: r.machineCode });
            if (Number.isFinite(t)) lastReplayed.set(r.machineCode, t);
            count += 1;
          } catch (e) {
            this.logger.warn(`stored message in bundle ${r.id} not replayed: ${e instanceof Error ? e.message : e}`);
          }
        });
      }
      if (rows.length < REPLAY_BATCH) break;
      cursor = rows[rows.length - 1].id;
    }
    if (count) this.logger.log(`history: ${count} stored device messages replayed into the charts`);
  }

  private async pruneHistory(): Promise<void> {
    const before = new Date(Date.now() - this.cfg!.historyDays * 86_400_000);
    const { count } = await this.prisma.vigilFrame.deleteMany({ where: { receivedAt: { lt: before } } });
    if (count) this.logger.log(`history: ${count} bundles of device messages older than ${this.cfg!.historyDays} days deleted`);
  }

  /** Every accepted message is stored: collected per machine and written as one bundle about every BUNDLE_MS. */
  private queueForStorage(machineId: string, machineCode: string, driver: string, frames: string[]): void {
    if (!frames.length) return;
    const key = `${machineId}\u0000${driver}`;
    const p = this.pending.get(key) ?? { machineId, machineCode, driver, frames: [], firstAt: new Date() };
    p.frames.push(...frames);
    this.pending.set(key, p);
    if (p.frames.length >= BUNDLE_MAX) void this.flushStorage(false);
  }

  /** Writes the bundles that are due (all of them when `all`, at shutdown). A failed write is logged; the engine keeps its data. */
  private async flushStorage(all: boolean): Promise<void> {
    const now = Date.now();
    const due = [...this.pending.entries()].filter(
      ([, p]) => all || p.frames.length >= BUNDLE_MAX || now - p.firstAt.getTime() >= BUNDLE_MS,
    );
    if (!due.length) return;
    for (const [key] of due) this.pending.delete(key);
    await this.prisma.vigilFrame
      .createMany({
        data: due.map(([, p]) => ({
          machineId: p.machineId,
          machineCode: p.machineCode,
          driver: p.driver,
          frames: p.frames,
          count: p.frames.length,
          firstAt: p.firstAt,
          receivedAt: new Date(now),
        })),
      })
      .catch((e: unknown) => this.logger.error(`device messages not stored: ${e instanceof Error ? e.message : e}`));
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
    const machines = await this.prisma.machine.findMany({
      where: { machineType: vigilTypes },
      select: { id: true, machineCode: true, hiddenSignals: true },
    });
    this.machineIds.clear();
    this.hidden.clear();
    for (const m of machines) {
      this.machineIds.set(m.machineCode, m.id);
      if (m.hiddenSignals.length) this.hidden.set(m.machineCode, new Set(m.hiddenSignals));
    }
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
    const acceptedFrames: string[] = [];
    let accepted = 0;
    for (const frame of input.frames) {
      try {
        parseOru(frame); // reject malformed messages with an AE before they reach the engine
        this.engine.receive(input.driver, frame, { deviceId: machine.machineCode });
        acceptedFrames.push(frame);
        acks.push(buildAck(frame, 'AA'));
        accepted += 1;
      } catch (e) {
        acks.push(buildAck(frame, 'AE', e instanceof Error ? e.message : String(e)));
      }
    }
    // Every accepted message goes to the database (the patient's complete record), in bundles.
    this.queueForStorage(machineId, machine.machineCode, input.driver, acceptedFrames);
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
    const snap = this.hub.snapshot(window, [...VIGIL_WINDOWS], controller, this.mode);
    if (!snap.ready || !this.hidden.size) return snap;
    // Values the superuser hides for a machine are left out of every screen (they are still stored and checked).
    return {
      ...snap,
      machines: snap.machines.map((m) => {
        const hide = this.hidden.get(m.deviceId);
        if (!hide) return m;
        const signals = m.signals.filter((g) => !hide.has(g.code));
        return { ...m, signals, hiddenSignals: m.signals.length - signals.length };
      }),
    };
  }

  /** A machine's values with whether each is shown: every value its type can report, plus any other it has sent. */
  async signalOptions(machineId: string): Promise<MachineSignalOption[]> {
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId }, select: { machineCode: true, machineType: true, hiddenSignals: true } });
    if (!machine) throw new NotFoundException('Machine not found');
    if (!isVigilMachineType(machine.machineType)) throw new BadRequestException('Only monitoring machines (ECMO, EBOO, monitors) have values to show or hide');
    const seen = this.hub?.machineSignals(machine.machineCode) ?? [];
    const codes = [...new Set([...signalsFor(machine.machineType), ...seen])].filter((c) => c in SIGNALS);
    const order = (c: string) => { const i = SIGNAL_ORDER.indexOf(c); return i < 0 ? SIGNAL_ORDER.length : i; };
    codes.sort((a, b) => order(a) - order(b));
    const hidden = new Set(machine.hiddenSignals);
    return codes.map((code) => ({ code, label: SIGNALS[code].description, unit: SIGNALS[code].unit, kind: SIGNALS[code].kind, hidden: hidden.has(code) }));
  }

  /** Superuser: which of a machine's values the portal shows. Display only; recorded in the audit log. */
  async setHiddenSignals(machineId: string, input: MachineHiddenSignalsInput, actor: AuthenticatedUser): Promise<MachineSignalOption[]> {
    // RolesGuard lets admin through every route: this choice is the superuser's alone.
    if (actor.role !== 'superuser') throw new ForbiddenException('Which values are shown is set by the superuser');
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId }, select: { machineCode: true, hiddenSignals: true } });
    if (!machine) throw new NotFoundException('Machine not found');
    const unknown = input.hidden.filter((c) => !(c in SIGNALS));
    if (unknown.length) throw new BadRequestException(`Unknown values: ${unknown.join(', ')}`);
    const hidden = [...new Set(input.hidden)];
    await this.prisma.machine.update({ where: { id: machineId }, data: { hiddenSignals: hidden } });
    if (hidden.length) this.hidden.set(machine.machineCode, new Set(hidden));
    else this.hidden.delete(machine.machineCode);
    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'MACHINE_VALUES_SHOWN_CHANGED',
      entityTable: 'machines',
      entityId: machineId,
      before: { hidden: machine.hiddenSignals },
      after: { hidden },
    });
    return this.signalOptions(machineId);
  }

  verifyAudit() {
    return this.ledger.verify(this.mode);
  }
}

/** The Vigil therapy a machine type's data belongs to (ECMO rules run only on ECMO). */
function therapyOf(machineType: string): string {
  return isVigilMachineType(machineType) ? VIGIL_THERAPY[machineType] : 'ECMO';
}
