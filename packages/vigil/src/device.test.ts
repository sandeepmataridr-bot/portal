// The 0dh.in device path (docs/vigil/esp32.md): the ESP32 gateway's HL7
// frames, coded "<SIGNAL>^<label>^0DH", reach the rules and the central
// station with no site configuration, exactly as a real console's would.
import { describe, expect, it } from 'vitest';
import { SIGNALS, SignalKind } from './codes.js';
import { parseOru } from './drivers.js';
import { VigilEngine } from './engine.js';
import { MonitorHub } from './monitor.js';
import { Normalizer, SignalQuality } from './pipeline.js';
import { WallClock } from './time.js';

/** One reading per OBX, as the gateway firmware writes them: [signal, value, UCUM unit]. */
const READINGS: [string, number, string][] = [
  ['ECMO_BLOOD_FLOW', 4.21, 'L/min'],
  ['ECMO_PUMP_SPEED', 3200, '{rpm}'],
  ['ECMO_P_VENOUS', -42, 'mm[Hg]'],
  ['ECMO_P_PRE_OXY', 231, 'mm[Hg]'],
  ['ECMO_P_POST_OXY', 192, 'mm[Hg]'],
  ['ECMO_OXY_DELTA_P', 39, 'mm[Hg]'],
  ['ECMO_SWEEP_FLOW', 3.0, 'L/min'],
  ['ECMO_FIO2', 100, '%'],
  ['ECMO_BLOOD_TEMP', 36.8, 'Cel'],
  ['ECMO_BUBBLE_ALARM', 0, '{flag}'],
  ['ECMO_LEVEL_ALARM', 0, '{flag}'],
  ['HU_WATER_TEMP', 30.2, 'Cel'],
  ['HU_SET_TEMP', 37.0, 'Cel'],
  ['HU_WATER_LEVEL', 90.0, '%'],
  ['HU_WATER_FLOW', 2.4, 'L/min'],
  ['HU_WATER_PRESSURE', 0.22, 'bar'],
  ['HU_GT38_ON', 0, '{flag}'],
  ['HU_LOW_WATER', 0, '{flag}'],
];

/** HL7 TS in UTC, as the gateway stamps it from NTP (firmware/esp32-ecmo-gateway). */
function utcStamp(t: number): string {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+0000`;
}

/** The message the gateway's buildFrame() writes. */
function gatewayFrame(t: number, readings = READINGS): string {
  const ts = utcStamp(t);
  const segs = [
    `MSH|^~\\&|ESP32GW|ECMO-001|0DH|PORTAL|${ts}||ORU^R01^ORU_R01|GW00000001|P|2.6`,
    `OBR|1|||ECMO^ECMO monitoring^0DH|||${ts}`,
    ...readings.map(([code, value, unit], i) => `OBX|${i + 1}|NM|${code}^${code}^0DH||${value}|${unit}^${unit}^UCUM|||||F|||${ts}`),
  ];
  return `${segs.join('\r')}\r`;
}

describe('0dh device frames', () => {
  it('maps every gateway reading to its Vigil signal in canonical units', () => {
    const t = 1792600000;
    const samples = parseOru(gatewayFrame(t));
    expect(samples).toHaveLength(READINGS.length);
    const n = Normalizer.withDefaults();
    for (const [i, s] of samples.entries()) {
      const obs = n.normalize('hl7_pcd01', s, 'as-1');
      const [code, value] = READINGS[i];
      expect(obs.flags.filter((f) => f !== 'SETTING')).toEqual([]);
      expect([obs.codeSystem, obs.code, obs.value, obs.unitUcum]).toEqual(['VIGIL', code, value, SIGNALS[code].ucum]);
      expect(s.deviceTime).toBe(t);
    }
  });

  it('never marks a steady alarm flag as a flatline, but range-checks it', () => {
    const q = new SignalQuality();
    for (let t = 0; t <= 600; t++) expect(q.assess('d', SIGNALS.HU_LOW_WATER, t, 0)).toEqual([1.0, []]);
    expect(new SignalQuality().assess('d', SIGNALS.ECMO_BUBBLE_ALARM, 0, 2)).toEqual([0.0, ['OUT_OF_RANGE']]);
  });

  it('does not call a value a flatline across a gap (device, network or server down)', () => {
    const q = new SignalQuality();
    for (let t = 0; t <= 20; t += 5) q.assess('d', SIGNALS.VITAL_SPO2, t, 97);
    // six minutes without data, then the same value again: watched for 0 s, not 6 min
    expect(q.assess('d', SIGNALS.VITAL_SPO2, 380, 97)).toEqual([1.0, []]);
    // a real flatline still shows once the value stays identical for 60 s without a gap
    let last: [number, string[]] = [1.0, []];
    for (let t = 385; t <= 445; t += 5) last = q.assess('d', SIGNALS.VITAL_SPO2, t, 97);
    expect(last).toEqual([0.3, ['FLATLINE']]);
  });

  it('keeps heater water flow apart from the patient blood flow', () => {
    const [s] = parseOru(gatewayFrame(1792600000, [['HU_WATER_FLOW', 0.0, 'L/min']]));
    expect(Normalizer.withDefaults().normalize('hl7_pcd01', s, 'as-1').code).toBe('HU_WATER_FLOW');
  });

  it('maps a vitals monitor from the gateway (0DH codes)', () => {
    const vitals: [string, number, string][] = [
      ['VITAL_SPO2', 97, '%'],
      ['VITAL_PULSE_RATE', 82, '{beats}/min'],
      ['VITAL_HEART_RATE', 81, '{beats}/min'],
      ['VITAL_NIBP_SYS', 118, 'mm[Hg]'],
      ['VITAL_NIBP_DIA', 76, 'mm[Hg]'],
      ['VITAL_NIBP_MEAN', 90, 'mm[Hg]'],
      ['VITAL_RESP_RATE', 16, '{breaths}/min'],
      ['VITAL_TEMP', 36.9, 'Cel'],
      ['VITAL_PERFUSION_INDEX', 2.4, '%'],
    ];
    const n = Normalizer.withDefaults();
    for (const [i, s] of parseOru(gatewayFrame(1792600000, vitals)).entries()) {
      const obs = n.normalize('hl7_pcd01', s, 'as-1');
      expect([obs.codeSystem, obs.code, obs.value, obs.flags]).toEqual(['VIGIL', vitals[i][0], vitals[i][1], []]);
    }
  });

  it('maps a standard bedside monitor (IEEE 11073 MDC codes and units)', () => {
    const ts = utcStamp(1792600000);
    const obx = (i: number, ident: string, value: number, unit: string) =>
      `OBX|${i}|NM|${ident}||${value}|${unit}|||||F|||${ts}`;
    const frame = [
      `MSH|^~\\&|MONITOR|BED-3|0DH|PORTAL|${ts}||ORU^R01^ORU_R01|M1|P|2.6`,
      `OBR|1|||VITALS|||${ts}`,
      obx(1, '150456^MDC_PULS_OXIM_SAT_O2^MDC', 96, '262688^MDC_DIM_PERCENT^MDC'),
      obx(2, '149530^MDC_PULS_OXIM_PULS_RATE^MDC', 88, '264864^MDC_DIM_BEAT_PER_MIN^MDC'),
      obx(3, '151562^MDC_RESP_RATE^MDC', 18, '264928^MDC_DIM_RESP_PER_MIN^MDC'),
      obx(4, '150364^MDC_TEMP_BODY^MDC', 98.6, '[degF]^[degF]^UCUM'),
    ].join('\r');
    const n = Normalizer.withDefaults();
    const got = parseOru(`${frame}\r`).map((s) => n.normalize('hl7_pcd01', s, 'as-1'));
    expect(got.map((o) => [o.code, Math.round(o.value * 10) / 10])).toEqual([
      ['VITAL_SPO2', 96],
      ['VITAL_PULSE_RATE', 88],
      ['VITAL_RESP_RATE', 18],
      ['VITAL_TEMP', 37],
    ]);
  });

  it('shows a LIVE console with all its readings before a patient is assigned', () => {
    const engine = new VigilEngine({
      liveMode: true,
      tenantId: 'hospital',
      unitId: 'icu-1',
      nodeId: 'icu-1-core-a',
      clock: new WallClock(),
      safetyRules: [],
      coreRules: [],
    });
    const hub = new MonitorHub(engine, { runId: 1 });
    engine.receive('hl7_pcd01', gatewayFrame(Math.floor(Date.now() / 1000)), { deviceId: 'ECMO-001' });

    const state = hub.snapshot(900, [900], null, 'live');
    if (!state.ready) throw new Error('monitor not ready');
    const [m] = state.machines;
    expect([m.deviceId, m.status]).toEqual(['ECMO-001', 'unassociated']);
    expect(m.signals.map((s) => s.code)).toEqual([
      'ECMO_BLOOD_FLOW',
      'ECMO_PUMP_SPEED',
      'ECMO_P_VENOUS',
      'ECMO_P_PRE_OXY',
      'ECMO_P_POST_OXY',
      'ECMO_OXY_DELTA_P',
      'ECMO_BLOOD_TEMP',
      'ECMO_SWEEP_FLOW',
      'ECMO_FIO2',
      'HU_WATER_TEMP',
      'HU_SET_TEMP',
      'HU_WATER_FLOW',
      'HU_WATER_PRESSURE',
      'HU_WATER_LEVEL',
      'HU_GT38_ON',
      'ECMO_BUBBLE_ALARM',
      'ECMO_LEVEL_ALARM',
      'HU_LOW_WATER',
    ]);
    const kind = (code: string) => m.signals.find((s) => s.code === code)!.kind;
    expect([kind('HU_LOW_WATER'), kind('HU_GT38_ON'), kind('HU_WATER_TEMP')]).toEqual([
      SignalKind.STATUS,
      SignalKind.SETTING,
      SignalKind.NUMERIC,
    ]);
    expect(m.unmapped).toBe(0);
  });

  it('maps every clinical value of the ECMO HMI: gas, air vent, heater mode, labs, alarm limits', () => {
    const hmi: [string, number, string][] = [
      ['ECMO_PUMP_TARGET', 3200, '{rpm}'],
      ['ECMO_SAO2', 98, '%'],
      ['ECMO_SWEEP_ON', 1, '{flag}'],
      ['ECMO_SWEEP_FLOW_ACTUAL', 3.0, 'L/min'],
      ['ECMO_FIO2_MEASURED', 59.6, '%'],
      ['ECMO_GAS_SOURCE', 2, '{code}'],
      ['ECMO_GAS_INLET_P', 3.2, 'bar'],
      ['ECMO_GAS_SUPPLY_P', 4.5, 'bar'],
      ['ECMO_AV_MODE', 0, '{code}'],
      ['ECMO_AV_VALVE', 0, '{code}'],
      ['ECMO_AV_DURATION', 10, 's'],
      ['ECMO_AV_IN_FLOW', 3.0, 'L/min'],
      ['ECMO_AV_EX_FLOW', 2.9, 'L/min'],
      ['HU_MODE', 2, '{code}'],
      ['LAB_HB', 11.2, 'g/dL'],
      ['LAB_HCT', 33.5, '%'],
      ['LAB_PH', 7.38, '[pH]'],
      ['LAB_PCO2', 41.2, 'mm[Hg]'],
      ['LAB_PO2', 215, 'mm[Hg]'],
      ['LAB_LACTATE', 1.8, 'mmol/L'],
      ['LAB_ALBUMIN', 3.5, 'g/dL'],
      ['LAB_ACT', 185, 's'],
      ['LIMIT_FLOW_LO', 1.0, 'L/min'],
      ['LIMIT_FLOW_HI', 6.0, 'L/min'],
      ['LIMIT_PUMP_HI', 5000, '{rpm}'],
      ['LIMIT_PV_LO', -100, 'mm[Hg]'],
      ['LIMIT_PA_HI', 300, 'mm[Hg]'],
      ['LIMIT_PIN_HI', 350, 'mm[Hg]'],
      ['LIMIT_DP_HI', 50, 'mm[Hg]'],
      ['LIMIT_TEMP_LO', 35.0, 'Cel'],
      ['LIMIT_TEMP_HI', 38.5, 'Cel'],
      ['LIMIT_SVO2_LO', 60, '%'],
      ['LIMIT_FIO2_LO', 21, '%'],
      ['LIMIT_GASP_LO', 2.5, 'bar'],
    ];
    const n = Normalizer.withDefaults();
    for (const [i, s] of parseOru(gatewayFrame(1792600000, hmi)).entries()) {
      const obs = n.normalize('hl7_pcd01', s, 'as-1');
      expect([obs.codeSystem, obs.code, obs.value]).toEqual(['VIGIL', hmi[i][0], hmi[i][1]]);
      expect(obs.flags.filter((f) => f !== 'SETTING')).toEqual([]);
    }
    expect([SIGNALS.LAB_PH.kind, SIGNALS.LAB_PH.decimals, SIGNALS.LIMIT_FLOW_LO.kind]).toEqual([SignalKind.LAB, 2, SignalKind.SETTING]);
    expect(SIGNALS.ECMO_GAS_SOURCE.states).toEqual(['Oxygen', 'Medical air', 'O2 + air']);
  });

  it('shows an EBOO machine (esp32-machine-simulator) with its ozone, UV and O2 readings', () => {
    const engine = new VigilEngine({
      liveMode: true,
      tenantId: 'hospital',
      unitId: 'icu-1',
      nodeId: 'icu-1-core-a',
      clock: new WallClock(),
      safetyRules: [],
      coreRules: [],
    });
    const hub = new MonitorHub(engine, { runId: 1 });
    const eboo: [string, number, string][] = [
      ['ECMO_PUMP_SPEED', 13.1, '{rpm}'],
      ['ECMO_BLOOD_FLOW', 0.131, 'L/min'],
      ['VITAL_HEART_RATE', 78, '{beats}/min'],
      ['VITAL_SPO2', 97, '%'],
      ['EBOO_OZONE_CONC', 31.2, 'ug/mL'],
      ['EBOO_OZONE_ON', 1, '{flag}'],
      ['EBOO_UV_ON', 1, '{flag}'],
      ['EBOO_O2_ON', 1, '{flag}'],
    ];
    engine.receive('hl7_pcd01', gatewayFrame(Math.floor(Date.now() / 1000), eboo), { deviceId: 'EBOO-001' });

    const state = hub.snapshot(900, [900], null, 'live');
    if (!state.ready) throw new Error('monitor not ready');
    const [m] = state.machines;
    expect([m.deviceId, m.kind, m.unmapped]).toEqual(['EBOO-001', 'EBOO', 0]);
    const sig = (code: string) => m.signals.find((s) => s.code === code)!;
    expect([sig('EBOO_OZONE_CONC').value, sig('EBOO_OZONE_CONC').unit, sig('EBOO_UV_ON').kind]).toEqual([31.2, 'ug/mL', SignalKind.SETTING]);
  });
});
