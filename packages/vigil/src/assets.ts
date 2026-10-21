/**
 * The rule files (rules/*.vrl) and patient scenarios (scenarios/**\/*.json)
 * shipped with this package. Resolved relative to the package root, so this
 * works the same from src/ (tests) and dist/ (API runtime).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileFiles, type CompiledRule } from './rules/compiler.js';
import { parseScenario, type Scenario } from './sim/scenario.js';

const ROOT = new URL('../', import.meta.url);
export const RULES_DIR = fileURLToPath(new URL('rules/', ROOT));
export const SCENARIO_DIR = fileURLToPath(new URL('scenarios/', ROOT));

export function bundledRuleFiles(): { source: string; text: string }[] {
  return readdirSync(RULES_DIR)
    .filter((f) => f.endsWith('.vrl'))
    .sort()
    .map((f) => ({ source: `rules/${f}`, text: readFileSync(RULES_DIR + f, 'utf-8') }));
}

/** Every bundled rule, compiled. Placement (safety floor vs core) comes from each rule's `safety_floor`. */
export function loadBundledRules(): { safety: CompiledRule[]; core: CompiledRule[] } {
  const all = compileFiles(bundledRuleFiles());
  return { safety: all.filter((r) => r.safetyFloor), core: all.filter((r) => !r.safetyFloor) };
}

export function ruleSourceText(source: string): string {
  const file = bundledRuleFiles().find((f) => f.source === source);
  if (!file) throw new Error(`unknown rule file ${source}`);
  return file.text;
}

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}${entry}`;
    if (statSync(full).isDirectory()) out.push(...walk(`${full}/`, `${prefix}${entry}/`));
    else if (entry.endsWith('.json')) out.push(`${prefix}${entry.slice(0, -'.json'.length)}`);
  }
  return out;
}

export function listScenarios(): string[] {
  return walk(SCENARIO_DIR).sort();
}

const cache = new Map<string, Scenario>();

/** Loads a bundled scenario by name (e.g. "ecmo/oxy_clot_01"). Only listed names resolve, never arbitrary paths. */
export function loadScenario(name: string): Scenario {
  const hit = cache.get(name);
  if (hit) return hit;
  const names = listScenarios();
  if (!names.includes(name)) throw new Error(`unknown scenario '${name}'; available: ${names.join(', ')}`);
  const sc = parseScenario(name, JSON.parse(readFileSync(`${SCENARIO_DIR}${name}.json`, 'utf-8')));
  cache.set(name, sc);
  return sc;
}
