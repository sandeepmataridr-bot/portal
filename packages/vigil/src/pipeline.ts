/**
 * The per-sample pipeline between a driver and the rules:
 *
 *   Normalizer            device codes/units -> Vigil signals in canonical UCUM units
 *   SignalQuality         per-channel quality index (0..1) with artifact flags
 *   AssociationRegistry   device -> encounter bindings and therapy episodes
 */
import { CODE_SYSTEM, DEVICE_CODE_SYSTEM, MDC_VITAL_CODES, SIGNALS, SignalKind, UnitConversionError, convert, type Signal } from './codes.js';
import type { DeviceAssociation, Observation, TherapyEpisode } from './contracts.js';
import type { RawSample } from './drivers.js';

// ── normalizer ─────────────────────────────────────────────────────────────

/** Vendor code -> Vigil signal, per driver (reference: edge/normalizer/maps/*.json). */
export const DEFAULT_CODE_MAPS: Record<string, Record<string, string>> = {
  hl7_pcd01: {
    'L:POST_OXY_PO2': 'BG_POST_OXY_PO2',
    // Our own device firmware (docs/vigil/esp32.md) codes each reading as
    // "<SIGNAL>^<label>^0DH", so it needs no site configuration.
    ...Object.fromEntries(Object.keys(SIGNALS).map((name) => [`${DEVICE_CODE_SYSTEM}:${name}`, name])),
    // Standard bedside monitors: IEEE 11073 codes ("<code>^<name>^MDC").
    ...Object.fromEntries(Object.entries(MDC_VITAL_CODES).map(([code, name]) => [`MDC:${code}`, name])),
  },
  sim_ecmo: { QB: 'ECMO_BLOOD_FLOW', DPOXY: 'ECMO_OXY_DELTA_P', SWEEP: 'ECMO_SWEEP_FLOW' },
};

/**
 * The raw value and unit are always kept. Anything that cannot be mapped or
 * converted is forwarded as a VENDOR observation with a flag, never dropped,
 * and never reaches the rules.
 */
export class Normalizer {
  readonly maps: Record<string, Record<string, string>>;

  constructor(maps: Record<string, Record<string, string>>) {
    for (const [driverId, table] of Object.entries(maps)) {
      for (const [code, signal] of Object.entries(table)) {
        if (!(signal in SIGNALS)) throw new Error(`map ${driverId}: '${code}' -> unknown signal '${signal}'`);
      }
    }
    this.maps = maps;
  }

  /** The bundled maps plus site-specific extras (e.g. VIGIL_HL7_CODES for LIVE mode). */
  static withDefaults(extra: Record<string, Record<string, string>> = {}): Normalizer {
    const maps: Record<string, Record<string, string>> = {};
    for (const [d, t] of Object.entries(DEFAULT_CODE_MAPS)) maps[d] = { ...t };
    for (const [d, t] of Object.entries(extra)) maps[d] = { ...(maps[d] ?? {}), ...t };
    return new Normalizer(maps);
  }

  normalize(driverId: string, raw: RawSample, associationId: string): Observation {
    const flags = [...raw.flags];
    const name = this.maps[driverId]?.[raw.vendorCode];
    const vendor = (flag: string): Observation => ({
      associationId,
      codeSystem: 'VENDOR',
      code: raw.vendorCode,
      value: raw.value,
      unitUcum: raw.unit,
      rawValue: raw.value,
      rawUnit: raw.unit,
      sqi: 1.0,
      flags: [...flags, flag],
    });
    if (name === undefined) return vendor('UNMAPPED');
    const sig = SIGNALS[name];
    let value: number;
    try {
      value = convert(raw.value, raw.unit, sig.ucum);
    } catch (e) {
      if (e instanceof UnitConversionError) return vendor('UNIT_UNCONVERTIBLE');
      throw e;
    }
    if (sig.kind === SignalKind.SETTING) flags.push('SETTING');
    return {
      associationId,
      codeSystem: CODE_SYSTEM,
      code: sig.name,
      value,
      unitUcum: sig.ucum,
      rawValue: raw.value,
      rawUnit: raw.unit,
      sqi: 1.0,
      flags,
    };
  }
}

// ── signal quality ─────────────────────────────────────────────────────────

export const FLATLINE_S = 60.0;
/** a "flush" lasting longer than this is accepted as a real level change */
export const MAX_ARTIFACT_S = 300.0;

interface Channel {
  baseline: number | null;
  artifactSince: number | null;
  lastValue: number | null;
  sameSince: number | null;
}

/**
 * Checks, in order:
 *   - out of plausible range        -> 0.0, OUT_OF_RANGE
 *   - step artifact (e.g. flush)    -> 0.1, FLUSH while the value stays away from baseline
 *   - flatline (numeric channels)   -> 0.3, FLATLINE after an identical value for FLATLINE_S
 * Settings and lab results only get the range check.
 */
export class SignalQuality {
  private readonly channels = new Map<string, Channel>();

  assess(key: string, sig: Signal, t: number, value: number): [number, string[]] {
    const [lo, hi] = sig.plausible;
    if (!(lo <= value && value <= hi)) return [0.0, ['OUT_OF_RANGE']];
    if (sig.kind !== SignalKind.NUMERIC) return [1.0, []];

    let ch = this.channels.get(key);
    if (!ch) {
      ch = { baseline: null, artifactSince: null, lastValue: null, sameSince: null };
      this.channels.set(key, ch);
    }
    let sqi = 1.0;
    let flags: string[] = [];

    if (sig.stepArtifact !== null) {
      if (ch.artifactSince !== null) {
        if (Math.abs(value - ch.baseline!) <= sig.stepArtifact / 3) {
          ch.artifactSince = null;
        } else if (t - ch.artifactSince > MAX_ARTIFACT_S) {
          ch.artifactSince = null;
          [sqi, flags] = [0.5, ['LEVEL_SHIFT']];
        } else {
          [sqi, flags] = [0.1, ['FLUSH']];
        }
      } else if (ch.baseline !== null && Math.abs(value - ch.baseline) > sig.stepArtifact) {
        ch.artifactSince = t;
        [sqi, flags] = [0.1, ['FLUSH']];
      }
      if (ch.artifactSince === null) ch.baseline = value;
    }

    if (value === ch.lastValue) {
      if (ch.sameSince !== null && t - ch.sameSince >= FLATLINE_S && sqi > 0.3) [sqi, flags] = [0.3, ['FLATLINE']];
    } else {
      ch.sameSince = t;
    }
    ch.lastValue = value;
    return [sqi, flags];
  }
}

// ── associations ───────────────────────────────────────────────────────────

/**
 * Device-to-encounter associations and therapy episodes. Observations are
 * bound to an association, never to a bare bed. Therapy rules only see data
 * from confirmed associations (plan epic 1.7).
 */
export class AssociationRegistry {
  private readonly assocs = new Map<string, DeviceAssociation>();
  private readonly episodes = new Map<string, TherapyEpisode>();

  addEpisode(episode: TherapyEpisode): void {
    this.episodes.set(episode.episodeId, episode);
  }

  add(assoc: DeviceAssociation): void {
    for (const other of this.assocs.values()) {
      if (other.deviceId === assoc.deviceId && other.end === null && other.associationId !== assoc.associationId) {
        throw new Error(`device ${assoc.deviceId} already has open association ${other.associationId}`);
      }
    }
    this.assocs.set(assoc.associationId, assoc);
  }

  all(): DeviceAssociation[] {
    return [...this.assocs.values()];
  }

  episode(episodeId: string): TherapyEpisode | undefined {
    return this.episodes.get(episodeId);
  }

  get(associationId: string): DeviceAssociation | undefined {
    return this.assocs.get(associationId);
  }

  confirm(associationId: string, by: string): DeviceAssociation {
    if (!by) throw new Error('confirmation needs the confirming user');
    const a = this.assocs.get(associationId);
    if (!a) throw new Error(`unknown association ${associationId}`);
    a.confirmed = true;
    a.confirmedBy = by;
    return a;
  }

  /** Ends the association and its therapy episode (if no other open association uses it). */
  end(associationId: string, at: number): DeviceAssociation {
    const a = this.assocs.get(associationId);
    if (!a) throw new Error(`unknown association ${associationId}`);
    a.end = at;
    const stillUsed = this.all().some((o) => o.end === null && o.therapyEpisodeId === a.therapyEpisodeId);
    const ep = this.episodes.get(a.therapyEpisodeId);
    if (ep && !stillUsed) ep.end = at;
    return a;
  }

  activeForDevice(deviceId: string, t: number): DeviceAssociation | undefined {
    for (const a of this.assocs.values()) {
      if (a.deviceId === deviceId && a.start <= t && (a.end === null || t < a.end)) return a;
    }
    return undefined;
  }

  /** The open association for a device, whatever the sample time (for wall-clock LIVE data). */
  openForDevice(deviceId: string): DeviceAssociation | undefined {
    for (const a of this.assocs.values()) if (a.deviceId === deviceId && a.end === null) return a;
    return undefined;
  }

  therapiesFor(encounterId: string): Set<string> {
    const out = new Set<string>();
    for (const e of this.episodes.values()) if (e.encounterId === encounterId && e.end === null) out.add(e.therapy);
    return out;
  }

  hasOpenConfirmed(encounterId: string): boolean {
    return this.all().some((a) => a.encounterId === encounterId && a.end === null && a.confirmed);
  }
}
