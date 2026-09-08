import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderChart, renderOverlay, parseValues, mergeValues } from "../src/render.js";
import { parseYaml } from "../src/yaml.js";
import { structuralChecks, runPolicyChecks } from "../src/checks.js";
import { loadChart, loadOverlays } from "../scripts/chart-files.mjs";
import { CHART, OVERLAYS } from "../demo/chart-data.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { chart } = loadChart(root);
const overlays = loadOverlays(root);

function kinds(manifests) {
  return manifests.map((manifest) => manifest.kind).sort();
}

test("the chart renders every template into a valid manifest", () => {
  const rendered = renderChart({ chart });
  assert.equal(rendered.length, 11);
  const manifests = rendered.flatMap((file) => file.docs);
  assert.equal(manifests.length, 11);
  assert.deepEqual(kinds(manifests), [
    "ConfigMap", "Deployment", "HorizontalPodAutoscaler", "Ingress", "NetworkPolicy",
    "Pod", "PodDisruptionBudget", "Secret", "Service", "ServiceAccount", "ServiceMonitor",
  ]);
  for (const manifest of manifests) {
    assert.ok(manifest.apiVersion, `${manifest.kind} has apiVersion`);
    assert.ok(manifest.metadata?.name, `${manifest.kind} has a name`);
  }
});

test("the deployment carries the security and reliability fields the README promises", () => {
  const deployment = renderChart({ chart }).flatMap((file) => file.docs).find((doc) => doc.kind === "Deployment");
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.seccompProfile.type, "RuntimeDefault");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.ok(container.resources.requests.cpu);
  assert.ok(container.resources.limits.memory);
  assert.ok(container.livenessProbe.httpGet.path);
  assert.ok(container.readinessProbe.httpGet.path);
  assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);
});

test("the default values render an HPA, PDB, NetworkPolicy and ServiceMonitor", () => {
  const manifests = renderChart({ chart }).flatMap((file) => file.docs);
  const hpa = manifests.find((doc) => doc.kind === "HorizontalPodAutoscaler");
  assert.equal(hpa.spec.scaleTargetRef.name, "webapp");
  assert.equal(hpa.spec.metrics[0].resource.target.averageUtilization, 70);
  assert.ok(manifests.find((doc) => doc.kind === "PodDisruptionBudget").spec.minAvailable);
  assert.ok(manifests.find((doc) => doc.kind === "NetworkPolicy").spec.policyTypes.includes("Ingress"));
  assert.ok(manifests.find((doc) => doc.kind === "ServiceMonitor").spec.endpoints[0].path);
});

test("every overlay renders, applies its namespace and its patches", () => {
  const expected = {
    dev: { namespace: "webapp-dev", replicas: 1, image: "ghcr.io/arvion/webapp:dev", environment: "dev" },
    staging: { namespace: "webapp-staging", replicas: 2, image: "ghcr.io/arvion/webapp:staging", environment: "staging" },
    prod: { namespace: "webapp-prod", replicas: 3, image: "ghcr.io/arvion/webapp:1.4.0", environment: "production" },
  };
  for (const overlay of overlays) {
    const result = renderOverlay({ chart, overlay });
    const manifests = result.manifests.map((entry) => entry.manifest);
    const deployment = manifests.find((manifest) => manifest.kind === "Deployment");
    const configMap = manifests.find((manifest) => manifest.kind === "ConfigMap");
    const ingress = manifests.find((manifest) => manifest.kind === "Ingress");
    const want = expected[overlay.name];
    assert.equal(result.namespace, want.namespace, overlay.name);
    assert.equal(deployment.metadata.namespace, want.namespace);
    assert.equal(deployment.spec.replicas, want.replicas, overlay.name);
    assert.equal(deployment.spec.template.spec.containers[0].image, want.image, overlay.name);
    assert.equal(configMap.data.APP_ENV, want.environment, overlay.name);
    assert.ok(ingress.spec.rules[0].host, overlay.name);
    assert.equal(manifests.length, 11, overlay.name);
  }
});

test("prod patches the HPA bounds after the values file rendered it", () => {
  const prod = overlays.find((overlay) => overlay.name === "prod");
  const manifests = renderOverlay({ chart, overlay: prod }).manifests.map((entry) => entry.manifest);
  const hpa = manifests.find((manifest) => manifest.kind === "HorizontalPodAutoscaler");
  assert.equal(hpa.spec.minReplicas, 3);
  assert.equal(hpa.spec.maxReplicas, 12);
});

test("every rendered overlay passes structural checks and every policy", () => {
  for (const overlay of overlays) {
    const result = renderOverlay({ chart, overlay });
    const manifests = result.manifests.map((entry) => entry.manifest);
    const structural = structuralChecks(manifests, {
      namespace: result.namespace,
      environment: result.values.environment,
      image: manifests.find((manifest) => manifest.kind === "Deployment").spec.template.spec.containers[0].image,
      replicas: manifests.find((manifest) => manifest.kind === "Deployment").spec.replicas,
      ingressHost: result.values.ingress.host,
      autoscaling: true,
    });
    assert.deepEqual(structural.filter((row) => row.status === "fail"), [], overlay.name);
    assert.deepEqual(runPolicyChecks(manifests).filter((row) => row.status === "fail"), [], overlay.name);
  }
});

test("base/ is generated from the current chart defaults", () => {
  const rendered = renderChart({ chart });
  for (const file of rendered) {
    if (file.path.startsWith("tests/")) continue;
    const name = file.path.split("/").pop();
    const basePath = join(root, "base", name);
    assert.ok(existsSync(basePath), `base/${name} exists`);
    assert.equal(readFileSync(basePath, "utf8").trim(), file.content.trim(), `base/${name} is stale`);
  }
});

test("base/kustomization.yaml lists every generated manifest", () => {
  const kustomization = parseYaml(readFileSync(join(root, "base/kustomization.yaml"), "utf8"));
  const files = kustomization.resources;
  assert.equal(files.length, 10);
  for (const file of files) assert.ok(existsSync(join(root, "base", file)), file);
});

test("demo/chart-data.js matches chart/ and overlays/ on disk", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(CHART)), JSON.parse(JSON.stringify(chart)),
    "demo data is stale — run `npm run sync`");
  assert.deepEqual(JSON.parse(JSON.stringify(OVERLAYS)), JSON.parse(JSON.stringify(overlays)),
    "overlay data is stale — run `npm run sync`");
});

test("each overlay kustomization targets resources that exist in the rendered chart", () => {
  for (const overlay of overlays) {
    const kustomization = parseYaml(overlay.kustomizationYaml);
    assert.equal(kustomization.namespace, `webapp-${overlay.name}`);
    assert.ok(kustomization.resources.includes("../../base"));
    const manifests = renderOverlay({ chart, overlay }).manifests.map((entry) => entry.manifest);
    for (const patch of kustomization.patches) {
      assert.ok(manifests.some((manifest) => manifest.kind === patch.target.kind && manifest.metadata.name === patch.target.name),
        `${overlay.name}: patch target ${patch.target.kind}/${patch.target.name}`);
    }
  }
});
