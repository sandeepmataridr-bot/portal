# Reference implementations

`vigil-python/` is the Python reference prototype of Vigil, copied unchanged from the `Portal.zip` hand-over
(minus `__pycache__` and its runtime `var/` audit data). It is the **executable specification** (ADR-004):

- the TypeScript engine in `packages/vigil` must reproduce its alarm times exactly
- `packages/vigil/scripts/export_golden.py` runs it to produce the golden files the replay suite checks

Treat it as read-only. If the specification changes, change it here first, re-export the golden files with
`py packages/vigil/scripts/export_golden.py`, then update the TypeScript port until `pnpm --filter @infusion/vigil test`
passes again. It runs on the Python 3.11+ standard library alone: `py vigilctl.py test-rules` inside the folder.
