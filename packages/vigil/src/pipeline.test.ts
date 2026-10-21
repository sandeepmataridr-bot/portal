// Ports of reference/vigil-python/test/unit/test_edge.py and test_modes.py,
// plus checks that the TS port's numerics match CPython exactly.
import { describe, expect, it } from 'vitest';
import { loadBundledRules } from './assets.js';
import { nextRecord, verifyChain, type AuditRecord } from './audit.js';
import { SIGNALS } from './codes.js';
import { loadVigilConfig, VigilConfigError } from './config.js';
import { AssociationMethod } from './contracts.js';
import { DriverHost, ModeViolation, SimEcmoDriver, buildAck, parseOru, type Driver } from './drivers.js';
import { VigilEngine } from './engine.js';
import { Normalizer, SignalQuality } from './pipeline.js';
import { SimBloodGasAnalyzer, SimCircConsole } from './sim/player.js';
import { PyRandom } from './sim/pyrandom.js';
import { SimClock, WallClock, pyFixed } from './time.js';

const raw = (vendorCode: string, value: number, unit: string) => ({
  deviceId: 'd',
  vendorCode,
  value,
  unit,
  deviceTime: 0,
  flags: [],
});

describe('normalizer', () => {
  const n = Normalizer.withDefaults();

  it('converts kPa to mmHg and keeps the raw value', () => {
    const obs = n.normalize('sim_ecmo', raw('DPOXY', 4.0, 'kPa'), 'as-1');
    expect([obs.codeSystem, obs.code, obs.unitUcum]).toEqual(['VIGIL', 'ECMO_OXY_DELTA_P', 'mm[Hg]']);
    expect(obs.value).toBeCloseTo(30.0, 2);
    expect([obs.rawValue, obs.rawUnit]).toEqual([4.0, 'kPa']);
  });

  it('flags unmapped data instead of dropping it', () => {
    const obs = n.normalize('sim_ecmo', raw('RPM', 3200, '/min'), 'as-1');
    expect([obs.codeSystem, obs.code, obs.value]).toEqual(['VENDOR', 'RPM', 3200]);
    expect(obs.flags).toContain('UNMAPPED');
  });

  it('flags unconvertible units', () => {
    expect(n.normalize('sim_ecmo', raw('DPOXY', 4.0, 'cm[H2O]'), 'as-1').flags).toContain('UNIT_UNCONVERTIBLE');
  });

  it('flags settings', () => {
    expect(n.normalize('sim_ecmo', raw('SWEEP', 3.0, 'L/min'), 'as-1').flags).toContain('SETTING');
  });

  it('refuses maps to unknown signals', () => {
    expect(() => Normalizer.withDefaults({ hl7_pcd01: { 'X:Y': 'NOPE' } })).toThrow(/unknown signal/);
  });
});

describe('signal quality', () => {
  it('detects a flush and recovers', () => {
    const q = new SignalQuality();
    const sig = SIGNALS.ECMO_OXY_DELTA_P;
    const out = [25, 25.5, 24.8, 105, 106, 104, 25.2, 25.1].map((v, i) => q.assess('d', sig, i * 5, v));
    expect(out.map(([s]) => s)).toEqual([1.0, 1.0, 1.0, 0.1, 0.1, 0.1, 1.0, 1.0]);
    expect(out[3][1]).toEqual(['FLUSH']);
  });

  it('marks out-of-range values', () => {
    expect(new SignalQuality().assess('d', SIGNALS.ECMO_BLOOD_FLOW, 0, 42.0)).toEqual([0.0, ['OUT_OF_RANGE']]);
  });

  it('detects a flatline', () => {
    const q = new SignalQuality();
    const out = Array.from({ length: 61 }, (_, t) => q.assess('d', SIGNALS.ECMO_BLOOD_FLOW, t, 4.0));
    expect(out[59]).toEqual([1.0, []]);
    expect(out[60]).toEqual([0.3, ['FLATLINE']]);
  });
});

describe('HL7 PCD-01', () => {
  const msg = new SimBloodGasAnalyzer().encode('bga-1', 'BG_POST_OXY_PO2', 'mm[Hg]', 18000.0, 176.0);

  it('parses ORU^R01', () => {
    const [s] = parseOru(msg);
    expect([s.deviceId, s.vendorCode, s.value, s.unit, s.deviceTime]).toEqual([
      'bga-1',
      'L:POST_OXY_PO2',
      176.0,
      'mm[Hg]',
      18000.0,
    ]);
  });

  it('maps MDC units and applies the timezone offset', () => {
    const m =
      'MSH|^~\\&|GW|ICU|VIGIL|EDGE|20261021120000+0200||ORU^R01|1|P|2.6\r' +
      'OBX|1|NM|150456^MDC_X^MDC||7.5|266016^MDC_DIM_KILO_PASCAL^MDC|||||F\r';
    const [s] = parseOru(m);
    expect([s.vendorCode, s.unit, s.deviceId]).toEqual(['MDC:150456', 'kPa', 'GW']);
    expect(s.deviceTime).toBe(1792576800.0); // 2026-10-21T10:00:00Z
  });

  it('rejects non-ORU messages, bad timestamps and non-finite values', () => {
    expect(() => parseOru('MSH|^~\\&|A|B|C|D|20260101||ADT^A01|1|P|2.6\r')).toThrow(/ORU\^R01/);
    expect(() => parseOru('MSH|^~\\&|A|B|C|D|20261341||ORU^R01|1|P|2.6\rOBX|1|NM|X^^L||1|x\r')).toThrow(/timestamp/);
    expect(() => parseOru('MSH|^~\\&|A|B|C|D|20260101||ORU^R01|1|P|2.6\rOBX|1|NM|X^^L||NaN|x\r')).toThrow(/numeric/);
  });

  it('echoes the control id in the ACK and strips delimiters from echoed text', () => {
    expect(buildAck(msg, 'AA')).toContain('MSA|AA|SIM000001');
    expect(buildAck(msg, 'AE', 'bad|value\rMSH')).toMatch(/MSA\|AE\|SIM000001\|bad value MSH\r$/);
  });
});

describe('driver host', () => {
  it('isolates a crashing driver and restarts it', () => {
    const faults: string[] = [];
    const host = new DriverHost(false, (d) => faults.push(d));
    const crashy = (): Driver => ({
      driverId: 'crashy',
      version: '0',
      simulated: false,
      decode() {
        throw new Error('boom');
      },
    });
    host.register(crashy);
    host.register(() => new SimEcmoDriver());
    const first = host.driver('crashy');
    expect(host.decode('crashy', 'x')).toEqual([]);
    expect(host.driver('crashy')).not.toBe(first);
    expect(faults).toEqual(['crashy']);
    const frame = new SimCircConsole().encode('d', 'ECMO_BLOOD_FLOW', 'L/min', 1.0, 4.0);
    expect(host.decode('sim_ecmo', frame)).toHaveLength(1);
  });
});

describe('association gating', () => {
  function node(confirmed: boolean) {
    const clock = new SimClock();
    const engine = new VigilEngine({
      liveMode: false,
      tenantId: 'sim-t',
      unitId: 'sim-u',
      nodeId: 'sim-e',
      clock,
      safetyRules: loadBundledRules().safety,
      coreRules: [],
    });
    engine.addAssociation(
      {
        associationId: 'as-1',
        deviceId: 'ecmo-1',
        encounterId: 'enc-1',
        therapyEpisodeId: 'ep-1',
        start: 0,
        end: null,
        method: AssociationMethod.BARCODE,
        confirmed,
        confirmedBy: confirmed ? 'rn' : '',
      },
      { episodeId: 'ep-1', encounterId: 'enc-1', therapy: 'ECMO', start: 0, end: null, attributes: {} },
    );
    return { engine, clock };
  }

  function feedLowFlow(engine: VigilEngine, clock: SimClock, start: number, seconds: number) {
    const console = new SimCircConsole();
    const raised = [];
    for (let t = start; t < start + seconds; t++) {
      clock.advanceTo(t);
      engine.receive('sim_ecmo', console.encode('ecmo-1', 'ECMO_BLOOD_FLOW', 'L/min', t, 0.5));
      raised.push(...engine.tick(t).filter((tr) => tr.kind === 'raised'));
    }
    return raised;
  }

  it('runs no therapy rules for an unconfirmed association', () => {
    const { engine, clock } = node(false);
    expect(feedLowFlow(engine, clock, 0, 30)).toEqual([]);
    expect(engine.stat('flag:UNCONFIRMED')).toBeGreaterThan(0);
  });

  it('enables rules once confirmed', () => {
    const { engine, clock } = node(false);
    feedLowFlow(engine, clock, 0, 10);
    engine.confirmAssociation('as-1', 'rn.smith (barcode)');
    const raised = feedLowFlow(engine, clock, 10, 30);
    expect(raised.map((tr) => tr.alert.problemKey)).toEqual(['ecmo.blood_flow_loss']);
    expect(raised[0].alert.testMode).toBe(true);
  });

  it('flags data from an unknown device', () => {
    const { engine } = node(true);
    const [env] = engine.receive('sim_ecmo', new SimCircConsole().encode('stranger', 'ECMO_BLOOD_FLOW', 'L/min', 0, 4.0));
    expect(env.payload.flags).toContain('UNASSOCIATED');
  });

  it('attributes samples to the device the caller names', () => {
    const { engine } = node(true);
    const [env] = engine.receive('sim_ecmo', new SimCircConsole().encode('stranger', 'ECMO_BLOOD_FLOW', 'L/min', 0, 4.0), {
      deviceId: 'ecmo-1',
    });
    expect(env.deviceId).toBe('ecmo-1');
    expect(env.payload.associationId).toBe('as-1');
  });

  it('resolves alerts and stops rules when the association ends', () => {
    const { engine, clock } = node(true);
    expect(feedLowFlow(engine, clock, 0, 30)).toHaveLength(1);
    const resolved = engine.endAssociation('as-1', 30, 'machine unassigned');
    expect(resolved.map((tr) => [tr.kind, tr.reason])).toEqual([['resolved', 'machine unassigned']]);
    expect(engine.alerts.active.size).toBe(0);
    expect(engine.safety.hasEncounter('enc-1')).toBe(false);
  });
});

describe('operating modes (ADR-005)', () => {
  it('defaults to TEST with synthetic identities', () => {
    const cfg = loadVigilConfig({});
    expect(cfg.liveMode).toBe(false);
    expect(cfg.tenantId).toBe('sim-hospital');
  });

  it('rejects a bad VIGIL_LIVE_MODE value', () => {
    expect(() => loadVigilConfig({ VIGIL_LIVE_MODE: 'maybe' })).toThrow(/VIGIL_LIVE_MODE/);
  });

  it('requires sim identities in TEST and a complete, non-sim identity in LIVE', () => {
    expect(() => loadVigilConfig({ VIGIL_TEST_TENANT_ID: 'general-hospital' })).toThrow(/must start with 'sim'/);
    expect(() => loadVigilConfig({ VIGIL_LIVE_MODE: 'true' })).toThrow(/VIGIL_LIVE_TENANT_ID is required/);
    expect(() =>
      loadVigilConfig({ VIGIL_LIVE_MODE: 'true', VIGIL_LIVE_TENANT_ID: 'sim-x', VIGIL_LIVE_UNIT_ID: 'cvicu-3' }),
    ).toThrow(/must not start with 'sim'/);
    expect(() =>
      loadVigilConfig({ VIGIL_LIVE_MODE: 'true', VIGIL_LIVE_TENANT_ID: 'gh', VIGIL_LIVE_UNIT_ID: 'u', VIGIL_HL7_CODES: '{"A":"NOPE"}' }),
    ).toThrow(VigilConfigError);
  });

  it('accepts a complete LIVE configuration', () => {
    const cfg = loadVigilConfig({
      VIGIL_LIVE_MODE: 'true',
      VIGIL_LIVE_TENANT_ID: 'general-hospital',
      VIGIL_LIVE_UNIT_ID: 'cvicu-3',
      VIGIL_HL7_CODES: '{"MDC:999": "ECMO_BLOOD_FLOW"}',
    });
    expect(cfg.liveMode).toBe(true);
    expect(cfg.nodeId).toBe('cvicu-3-core-a');
    expect(cfg.codeMaps).toEqual({ hl7_pcd01: { 'MDC:999': 'ECMO_BLOOD_FLOW' } });
  });

  it('refuses simulated drivers and the simulated clock in LIVE mode', () => {
    expect(() => new DriverHost(true).register(() => new SimEcmoDriver())).toThrow(ModeViolation);
    const base = { tenantId: 'gh', unitId: 'u', nodeId: 'n', safetyRules: [], coreRules: [] };
    expect(() => new VigilEngine({ ...base, liveMode: true, clock: new SimClock() })).toThrow(ModeViolation);
    const live = new VigilEngine({ ...base, liveMode: true, clock: new WallClock() });
    expect(() => live.receive('sim_ecmo', 'SC1|d|0|QB|4|L/min')).toThrow(ModeViolation);
  });
});

describe('audit chain', () => {
  it('detects tampering', () => {
    const records: AuditRecord[] = [];
    for (const kind of ['a', 'b', 'c']) records.push(nextRecord(records.at(-1) ?? null, kind, { n: records.length }));
    expect(verifyChain(records)).toEqual({ ok: true, count: 3, error: '' });
    const edited = records.map((r, i) => (i === 1 ? { ...r, data: { n: 99 } } : r));
    expect(verifyChain(edited)).toEqual({ ok: false, count: 1, error: 'seq 2: hash mismatch' });
    expect(verifyChain([records[0], records[2]]).ok).toBe(false);
  });
});

describe('CPython parity', () => {
  it('reproduces random.Random(seed) exactly', () => {
    const r = new PyRandom(505);
    expect([r.random(), r.random(), r.random()]).toEqual([0.14960684073609387, 0.8443100623742851, 0.2805013532789453]);
    const g = new PyRandom(202);
    expect([g.gauss(0, 1), g.gauss(0, 1), g.gauss(0, 1)]).toEqual([
      0.12533062274584866, -1.4332942440908543, -0.5597643413692804,
    ]);
    expect(new PyRandom(2 ** 40 + 7).random()).toBe(0.6137037779936511);
  });

  it('formats like Python, rounding exact ties half to even', () => {
    expect(pyFixed(0.125, 2)).toBe('0.12');
    expect(pyFixed(0.375, 2)).toBe('0.38');
    expect(pyFixed(2.5, 0)).toBe('2');
    expect(pyFixed(176.0, 0)).toBe('176');
    expect(pyFixed(4.12, 1)).toBe('4.1');
    expect(pyFixed(-0.03125, 4)).toBe('-0.0312');
  });
});
