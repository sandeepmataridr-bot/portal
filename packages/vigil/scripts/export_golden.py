"""Exports golden outputs from the Python reference prototype (reference/vigil-python).

For every bundled scenario, plays it through the reference edge node with every
rule loaded and records:
  * the device frame stream (count + SHA-256), proving the TS simulator emits
    byte-identical frames (same PRNG, same number formatting)
  * node stats (observations, flag counts)
  * every alert transition with its exact time and explanation text

The TS port (`src/replay.test.ts`) must reproduce these exactly (ADR-004:
"identical rule hits"). Re-run after any change to the reference:

    py packages/vigil/scripts/export_golden.py
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REF = HERE.parents[2] / "reference" / "vigil-python"
OUT = HERE.parent / "test" / "golden"
sys.path.insert(0, str(REF))
sys.dont_write_bytecode = True

from core.cds_runtime import load_core_rules  # noqa: E402
from edge.node import EdgeNode  # noqa: E402
from edge.safety_engine import load_safety_rules  # noqa: E402
from shared.vigil_rules import compile_source  # noqa: E402
from shared.vigil_time import SimClock  # noqa: E402
from simulators.player import frames  # noqa: E402
from simulators.scenario import list_scenarios, load_scenario  # noqa: E402
from tools.modes import play, setup_scenario  # noqa: E402


def run(scenario_name: str, safety, core) -> dict:
    sc = load_scenario(scenario_name)
    stream = frames(sc)
    digest = hashlib.sha256()
    for f in stream:
        digest.update(f"{f.t!r}|{f.driver_id}|{f.frame}\n".encode())
    clock = SimClock(0.0)
    node = EdgeNode(live_mode=False, tenant_id="sim-golden", unit_id="sim-golden", edge_node_id="sim-golden",
                    clock=clock, safety_rules=safety, core_rules=core)
    setup_scenario(node, sc)
    transitions = play(node, sc, clock, stream=stream)
    return {
        "scenario": scenario_name,
        "frames": {"count": len(stream), "sha256": digest.hexdigest(),
                   "first": [[f.t, f.driver_id, f.frame] for f in stream[:4]]},
        "stats": dict(sorted(node.stats.items())),
        "transitions": [{"kind": tr.kind, "rule": tr.alert.problem_key, "priority": tr.alert.priority.value,
                         "origin": tr.alert.origin.value, "at": tr.at, "explanation": tr.alert.explanation}
                        for tr in transitions],
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    safety, core = load_safety_rules(), load_core_rules()
    for name in list_scenarios():
        data = run(name, safety, core)
        path = OUT / f"{name.replace('/', '__')}.json"
        path.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
        print(f"{name}: {data['frames']['count']} frames, {len(data['transitions'])} transitions -> {path.name}")

    # The flush scenario with SQI gating removed must fire (proves the negative test bites).
    [rule] = core
    text = Path(rule.source).read_text(encoding="utf-8").replace(", min_sqi 0.8", "")
    data = run("ecmo/flush_artifact", [], compile_source(text))
    (OUT / "ungated__flush_artifact.json").write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    print(f"ungated flush_artifact: {len(data['transitions'])} transitions")


if __name__ == "__main__":
    main()
