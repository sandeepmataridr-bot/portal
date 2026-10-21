/**
 * Alert lifecycle (reference: edge/local_alarm). Priority markers follow
 * IEC 60601-1-8 (!!! high, !! medium, ! low). TEST-mode alerts are always
 * labelled TEST and are never sent to a nurse-call adapter.
 */
import type { Alert, Origin, Priority } from './contracts.js';
import type { RuleEvent } from './rules/host.js';
import { newEventId } from './time.js';

export const PRIORITY_ORDER: Record<Priority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, ADVISORY: 3 };
export const MARKERS: Record<Priority, string> = { HIGH: '!!!', MEDIUM: '!!', LOW: '!', ADVISORY: 'i' };

/** Last 8 hex digits: the random part of the UUIDv7 (the front is a timestamp). */
export function shortId(alert: Alert): string {
  return alert.alertId.replaceAll('-', '').slice(-8);
}

export interface Transition {
  kind: 'raised' | 'resolved' | 'acknowledged';
  alert: Alert;
  at: number;
  /** why a resolve happened outside the rule's own clear condition */
  reason?: string;
}

export class AlertNotFound extends Error {}

/** Active alerts, keyed by (rule id, encounter). */
export class AlertBook {
  readonly active = new Map<string, Alert>();

  constructor(readonly testMode: boolean) {}

  private static key(ruleId: string, encounterId: string): string {
    return `${ruleId}\u0000${encounterId}`;
  }

  apply(ev: RuleEvent, origin: Origin): Transition | null {
    const key = AlertBook.key(ev.rule.ruleId, ev.encounterId);
    if (ev.kind === 'fire') {
      const alert: Alert = {
        alertId: newEventId(),
        encounterId: ev.encounterId,
        priority: ev.rule.priority,
        problemKey: ev.rule.ruleId,
        findings: [{ rule: { ruleId: ev.rule.ruleId, ruleVersion: `v${ev.rule.version}` } }],
        state: 'ACTIVE',
        explanation: ev.explanation,
        evidenceEventIds: [],
        origin,
        raisedTime: ev.at,
        testMode: this.testMode,
        resolvedTime: null,
        acknowledgedBy: '',
      };
      this.active.set(key, alert);
      return { kind: 'raised', alert, at: ev.at };
    }
    const alert = this.active.get(key);
    if (!alert) return null;
    this.active.delete(key);
    alert.state = 'RESOLVED';
    alert.resolvedTime = ev.at;
    return { kind: 'resolved', alert, at: ev.at };
  }

  /**
   * Resolves every active alert for an encounter whose rules stopped running
   * (the device association ended): nothing would ever clear them otherwise.
   */
  resolveEncounter(encounterId: string, at: number, reason: string): Transition[] {
    const out: Transition[] = [];
    for (const [key, alert] of this.active) {
      if (alert.encounterId !== encounterId) continue;
      this.active.delete(key);
      alert.state = 'RESOLVED';
      alert.resolvedTime = at;
      out.push({ kind: 'resolved', alert, at, reason });
    }
    return out;
  }

  /** ref is the short id shown on screen, or the full alert id. */
  acknowledge(ref: string, by: string, at: number): Transition {
    if (!by.trim()) throw new AlertNotFound('acknowledgement needs the acknowledging user');
    const matches = [...this.active.values()].filter((a) => ref === a.alertId || ref === shortId(a));
    if (matches.length !== 1) throw new AlertNotFound(`${matches.length} active alerts match '${ref}'`);
    const alert = matches[0];
    alert.state = 'ACKNOWLEDGED';
    alert.acknowledgedBy = by;
    return { kind: 'acknowledged', alert, at };
  }
}
