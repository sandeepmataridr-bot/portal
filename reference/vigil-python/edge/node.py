"""Edge node: driver -> normalizer -> SQI -> edge bus -> rules -> local alarm.

    receive(driver_id, frame)   ingest one device frame
    tick(now)                   evaluate rules; returns alert transitions

The node is single-threaded; LIVE mode feeds it from a queue.
"""
from __future__ import annotations

from collections import Counter
from typing import Callable

from core.audit_ledger import AuditLedger
from core.cds_runtime import CdsRuntime
from edge.association import AssociationRegistry
from edge.driver_sdk import DriverHost
from edge.drivers import Hl7Pcd01Driver, SimEcmoDriver
from edge.local_alarm import AlertBook, ConsolePresenter, NurseCall, Transition
from edge.normalizer import Normalizer
from edge.safety_engine import SafetyEngine
from edge.sqi import SignalQuality
from shared.vigil_codes import CODE_SYSTEM, SIGNALS
from shared.vigil_contracts import DeviceAssociation, Envelope, Origin, Provenance, TherapyEpisode
from shared.vigil_rules import CompiledRule
from shared.vigil_time import new_event_id


class EdgeBus:
    """In-process stand-in for the NATS JetStream edge bus (plan epic 1.11)."""

    def __init__(self):
        self._subs: dict[str, list[Callable[[Envelope], None]]] = {}

    def subscribe(self, topic: str, fn: Callable[[Envelope], None]) -> None:
        self._subs.setdefault(topic, []).append(fn)

    def publish(self, topic: str, env: Envelope) -> None:
        for fn in self._subs.get(topic, ()):
            fn(env)


class EdgeNode:
    def __init__(self, *, live_mode: bool, tenant_id: str, unit_id: str, edge_node_id: str, clock,
                 safety_rules: list[CompiledRule], core_rules: list[CompiledRule],
                 presenter: ConsolePresenter | None = None, audit: AuditLedger | None = None,
                 nurse_call: NurseCall | None = None, hl7_codes: dict[str, str] | None = None):
        if live_mode and clock.simulated:
            raise ValueError("LIVE mode requires the wall clock")
        if nurse_call is not None and not live_mode:
            raise ValueError("nurse call is never connected in TEST mode")
        self.live_mode = live_mode
        self.tenant_id, self.unit_id, self.edge_node_id = tenant_id, unit_id, edge_node_id
        self.clock = clock
        self.presenter, self.audit, self.nurse_call = presenter, audit, nurse_call
        self.listeners: list[Callable[[Transition], None]] = []
        self.stats: Counter = Counter()

        self.drivers = DriverHost(live_mode, on_fault=self._driver_fault)
        self.drivers.register(Hl7Pcd01Driver)
        if not live_mode:
            self.drivers.register(SimEcmoDriver)
        self.normalizer = Normalizer.from_files({"hl7_pcd01": hl7_codes or {}})
        self.sqi = SignalQuality()
        self.associations = AssociationRegistry()
        self.safety = SafetyEngine(safety_rules)
        self.cds = CdsRuntime(core_rules)
        self.alerts = AlertBook(test_mode=not live_mode)
        self.bus = EdgeBus()
        self.bus.subscribe("observation", self._to_rules)

    # -- associations ------------------------------------------------------
    def add_association(self, assoc: DeviceAssociation, episode: TherapyEpisode) -> None:
        self.associations.add_episode(episode)
        self.associations.add(assoc)
        self._audit("association", {"association_id": assoc.association_id, "device_id": assoc.device_id,
                                    "encounter_id": assoc.encounter_id, "therapy": episode.therapy,
                                    "confirmed": assoc.confirmed, "confirmed_by": assoc.confirmed_by})
        if assoc.confirmed:
            self._open(assoc)

    def confirm_association(self, association_id: str, by: str) -> None:
        assoc = self.associations.confirm(association_id, by)
        self._audit("association_confirmed", {"association_id": association_id, "by": by})
        self._open(assoc)

    def _open(self, assoc: DeviceAssociation) -> None:
        therapies = self.associations.therapies_for(assoc.encounter_id)
        for engine in (self.safety, self.cds):
            engine.open_encounter(assoc.encounter_id, therapies, assoc.start)

    # -- data path ---------------------------------------------------------
    def receive(self, driver_id: str, frame: str) -> list[Envelope]:
        out = []
        driver = self.drivers.driver(driver_id)
        for raw in self.drivers.decode(driver_id, frame):
            assoc = self.associations.active_for_device(raw.device_id, raw.device_time)
            obs = self.normalizer.normalize(driver_id, raw, assoc.association_id if assoc else "")
            if obs.code_system == CODE_SYSTEM:
                sqi, flags = self.sqi.assess((raw.device_id, obs.code), SIGNALS[obs.code], raw.device_time, obs.value)
                obs.sqi = sqi
                obs.flags += flags
            if assoc is None:
                obs.flags.append("UNASSOCIATED")
            elif not assoc.confirmed:
                obs.flags.append("UNCONFIRMED")
            for flag in obs.flags:
                self.stats[f"flag:{flag}"] += 1
            env = Envelope(
                event_id=new_event_id(), tenant_id=self.tenant_id, unit_id=self.unit_id,
                source_id=f"spiffe://{self.tenant_id}/{self.unit_id}/device/{raw.device_id}",
                valid_time=raw.device_time, recorded_time=self.clock.now(), clock_offset_us=0,
                schema="vigil.v1.Observation", payload=obs,
                provenance=Provenance(driver.driver_id, driver.version, self.edge_node_id),
                test_mode=not self.live_mode)
            self.stats["observations"] += 1
            self.bus.publish("observation", env)
            out.append(env)
        return out

    def _to_rules(self, env: Envelope) -> None:
        if env.test_mode != (not self.live_mode):
            raise ValueError("envelope from the other operating mode")
        obs = env.payload
        if obs.code_system != CODE_SYSTEM:
            return
        assoc = self.associations.get(obs.association_id)
        if assoc is None or not assoc.confirmed:
            return
        for engine in (self.safety, self.cds):
            engine.observe(assoc.encounter_id, obs.code, env.valid_time, obs.value, obs.sqi, obs.flags)

    # -- evaluation --------------------------------------------------------
    def tick(self, now: float) -> list[Transition]:
        out = []
        for origin, engine in ((Origin.EDGE_SAFETY_FLOOR, self.safety), (Origin.CORE, self.cds)):
            for ev in engine.tick(now):
                tr = self.alerts.apply(ev, origin)
                if tr:
                    self._announce(tr)
                    out.append(tr)
        return out

    def acknowledge(self, id_prefix: str, by: str) -> Transition:
        tr = self.alerts.acknowledge(id_prefix, by, self.clock.now())
        self._announce(tr)
        return tr

    def _announce(self, tr: Transition) -> None:
        self.stats[f"alerts_{tr.kind}"] += 1
        a = tr.alert
        if self.presenter:
            self.presenter.show(tr)
        self._audit(f"alert_{tr.kind}", {
            "alert_id": a.alert_id, "rule": a.problem_key, "rule_version": a.findings[0].rule.rule_version,
            "encounter_id": a.encounter_id, "priority": a.priority.value, "origin": a.origin.value,
            "valid_time": tr.at, "explanation": a.explanation, "test_mode": a.test_mode,
            "acknowledged_by": a.acknowledged_by})
        if self.nurse_call and tr.kind in ("raised", "resolved"):
            self.nurse_call.send(tr)
        for fn in self.listeners:
            fn(tr)

    def _driver_fault(self, driver_id: str, error: Exception) -> None:
        self.stats["driver_faults"] += 1
        self._audit("driver_fault", {"driver_id": driver_id, "error": str(error)[:200]})

    def _audit(self, kind: str, data: dict) -> None:
        if self.audit:
            self.audit.append(kind, {"mode": "live" if self.live_mode else "test", **data})
