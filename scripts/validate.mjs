#!/usr/bin/env node
// Render the chart through every overlay and check the result structurally.
//
//   node scripts/validate.mjs
//
// Helm is not required. When it is installed, scripts/validate.sh additionally
// renders with the real `helm template` and runs conftest if available.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderChart, renderOverlay, mergeValues, parseValues } from "../src/render.js";
import { parseYaml } from "../src/yaml.js";
import { runPolicyChecks, structuralChecks, summarise, POLICY_RULES } from "../src/checks.js";
import { loadChart, loadOverlays } from "./chart-files.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { chart } = loadChart(root);
const overlays = loadOverlays(root);
let failures = 0;
let checksRun = 0;

function row(status, area, name, detail = "") {
  checksRun++;
  if (status === "fail") failures++;
  const mark = status === "pass" ? "ok  " : "FAIL";
  console.log(`  ${mark} ${area.padEnd(11)} ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ---------------------------------------------------------------- base drift */

console.log("\nbase/ drift");
const baseDir = join(root, "base");
const defaults = renderChart({ chart });
let drift = 0;
for (const file of defaults) {
  if (file.path.startsWith("tests/")) continue;
  const name = file.path.split("/").pop();
  const basePath = join(baseDir, name);
  if (!existsSync(basePath)) { drift++; console.log(`  FAIL base/ missing ${name} (run scripts/render-base.mjs)`); continue; }
  const baseText = readFileSync(basePath, "utf8");
  if (baseText.trim() !== file.content.trim()) { drift++; console.log(`  FAIL base/${name} does not match chart defaults`); }
}
failures += drift;
checksRun++;
console.log(drift ? `  FAIL base/ is stale` : `  ok   base/ matches chart defaults (${defaults.length - 1} manifests)`);

/* ------------------------------------------------------------------- overlays */

for (const overlay of overlays) {
  console.log(`\noverlay ${overlay.name}`);
  const result = renderOverlay({ chart, overlay });
  const manifests = result.manifests.map((entry) => entry.manifest);
  const values = result.values;
  const kustomization = parseYaml(overlay.kustomizationYaml) ?? {};

  // Derive expectations from the overlay files instead of hard-coding them, so a
  // mismatch between values.yaml and a patch is caught rather than mirrored.
  const patchFor = (suffix) => {
    const content = overlay.patchFiles[suffix];
    return content ? parseYaml(content) : [];
  };
  const findReplace = (operations, path) => operations.find((operation) => operation.op === "replace" && operation.path === path)?.value;
  const replicas = findReplace(patchFor("patch-replicas.yaml"), "/spec/replicas");
  const image = findReplace(patchFor("patch-image.yaml"), "/spec/template/spec/containers/0/image");
  const ingressHost = values.ingress?.host;
  const environment = values.environment;
  const expected = {
    namespace: kustomization.namespace,
    environment,
    image,
    replicas,
    ingressHost,
    autoscaling: values.autoscaling?.enabled,
    pdb: values.pdb?.enabled,
    serviceMonitor: values.serviceMonitor?.enabled,
    networkPolicy: values.networkPolicy?.enabled,
    serviceAccount: values.serviceAccount?.create,
    secret: values.secret?.enabled,
  };

  const structural = structuralChecks(manifests, expected);
  for (const check of structural) row(check.status, "manifests", check.name, check.status === "pass" ? "" : check.detail);
  const policies = runPolicyChecks(manifests);
  for (const check of policies) row(check.status, "policy", check.rule, check.status === "pass" ? "" : check.detail);

  // Patches must have matched something: a typo in a target name otherwise
  // passes silently with the default value.
  const kinds = new Set(manifests.map((manifest) => manifest.kind));
  for (const patch of kustomization.patches ?? []) {
    row(kinds.has(patch.target?.kind) ? "pass" : "fail", "patches", `${patch.path} → ${patch.target?.kind}/${patch.target?.name}`,
      kinds.has(patch.target?.kind) ? "" : "target kind not rendered");
  }

  const summary = summarise([...structural, ...policies]);
  console.log(`  ${summary.fail ? "FAIL" : "PASS"} ${summary.pass}/${summary.total} structural + policy checks · ${manifests.length} manifests · namespace ${result.namespace}`);
}

console.log(`\n${overlays.length} overlays · ${checksRun} checks · ${failures} failure(s)`);
if (failures) {
  console.error("validation failed");
  process.exit(1);
}
console.log("blueprint validation passed (helm not required)");
