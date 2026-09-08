import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderChart, renderOverlay } from "../src/render.js";
import { runPolicyChecks, structuralChecks, summarise, POLICY_RULES } from "../src/checks.js";
import { loadChart, loadOverlays } from "../scripts/chart-files.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { chart } = loadChart(root);
const overlays = loadOverlays(root);
const baseManifests = renderChart({ chart }).flatMap((file) => file.docs);
const clone = () => JSON.parse(JSON.stringify(baseManifests));

function deployment(manifests) {
  return manifests.find((manifest) => manifest.kind === "Deployment");
}

const allPass = (rows) => rows.every((row) => row.status === "pass");

test("all policy rules pass on the chart defaults", () => {
  const rows = runPolicyChecks(baseManifests);
  assert.equal(rows.length, POLICY_RULES.length);
  assert.deepEqual(rows.filter((row) => row.status === "fail"), []);
});

test("an untagged or latest image fails the image policy", () => {
  for (const image of ["webapp", "webapp:latest"]) {
    const manifests = clone();
    deployment(manifests).spec.template.spec.containers[0].image = image;
    const rows = runPolicyChecks(manifests);
    assert.equal(rows.find((row) => row.rule === "no-latest-image").status, "fail", image);
  }
});

test("missing requests or limits fail the resource policy", () => {
  for (const mutate of [
    (container) => { delete container.resources.requests.cpu; },
    (container) => { delete container.resources.limits.memory; },
    (container) => { delete container.resources; },
  ]) {
    const manifests = clone();
    mutate(deployment(manifests).spec.template.spec.containers[0]);
    assert.equal(runPolicyChecks(manifests).find((row) => row.rule === "resource-requests-and-limits").status, "fail");
  }
});

test("root containers, writable filesystems and privilege escalation fail security", () => {
  const cases = [
    ["run-as-non-root", (pod, container) => {
      delete pod.securityContext.runAsNonRoot;
      delete pod.securityContext.runAsUser;
      delete container.securityContext.runAsNonRoot;
    }],
    ["read-only-root-filesystem", (pod, container) => { container.securityContext.readOnlyRootFilesystem = false; }],
    ["no-privilege-escalation", (pod, container) => { container.securityContext.allowPrivilegeEscalation = true; }],
  ];
  for (const [rule, mutate] of cases) {
    const manifests = clone();
    const pod = deployment(manifests).spec.template.spec;
    mutate(pod, pod.containers[0]);
    assert.equal(runPolicyChecks(manifests).find((row) => row.rule === rule).status, "fail", rule);
  }
});

test("hostPath volumes and missing probes fail their policies", () => {
  const manifests = clone();
  deployment(manifests).spec.template.spec.volumes.push({ name: "docker", hostPath: { path: "/var/run/docker.sock" } });
  assert.equal(runPolicyChecks(manifests).find((row) => row.rule === "no-host-path-volumes").status, "fail");

  const probes = clone();
  delete deployment(probes).spec.template.spec.containers[0].livenessProbe;
  assert.equal(runPolicyChecks(probes).find((row) => row.rule === "probes-defined").status, "fail");
});

test("structural checks catch a stale image, wrong replicas and a mismatched host", () => {
  const overlay = overlays.find((entry) => entry.name === "prod");
  const result = renderOverlay({ chart, overlay });
  const manifests = result.manifests.map((entry) => entry.manifest);
  const deploymentManifest = deployment(manifests);
  const expected = {
    namespace: result.namespace,
    environment: result.values.environment,
    image: deploymentManifest.spec.template.spec.containers[0].image,
    replicas: deploymentManifest.spec.replicas,
    ingressHost: result.values.ingress.host,
    autoscaling: true,
  };
  assert.deepEqual(structuralChecks(manifests, expected).filter((row) => row.status === "fail"), []);

  const wrong = structuralChecks(manifests, { ...expected, image: "ghcr.io/arvion/webapp:other", replicas: 99, ingressHost: "wrong.example.com" });
  const failed = wrong.filter((row) => row.status === "fail").map((row) => row.name);
  assert.ok(failed.includes("Container image is the overlay image"));
  assert.ok(failed.includes("Deployment replicas match the overlay"));
  assert.ok(failed.includes("Ingress host matches the overlay"));
});

test("structural checks fail when a promised resource is missing", () => {
  const overlay = overlays.find((entry) => entry.name === "dev");
  const result = renderOverlay({ chart, overlay });
  const manifests = result.manifests.map((entry) => entry.manifest).filter((manifest) => manifest.kind !== "ServiceMonitor");
  const rows = structuralChecks(manifests, {
    namespace: result.namespace,
    environment: result.values.environment,
    image: "ghcr.io/arvion/webapp:dev",
    replicas: 1,
    ingressHost: result.values.ingress.host,
    autoscaling: true,
    serviceMonitor: true,
  });
  assert.equal(rows.find((row) => row.name === "ServiceMonitor rendered").status, "fail");
});

test("summarise counts passes and failures", () => {
  assert.deepEqual(summarise([{ status: "pass" }, { status: "pass" }, { status: "fail" }]), { pass: 2, fail: 1, total: 3 });
});
