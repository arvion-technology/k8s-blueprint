// K8s Blueprint demo: a manifest explorer driven by the real chart.
//
// The chart templates, values and overlays are embedded in chart-data.js by
// scripts/sync-demo.mjs. Everything below calls the same renderer the validator
// uses; there is no pre-rendered YAML in this file.
import { renderOverlay } from "../src/render.js";
import { stringifyYaml } from "../src/yaml.js";
import { runPolicyChecks, structuralChecks, summarise } from "../src/checks.js";
import { CHART, OVERLAYS } from "./chart-data.js";

const $ = A.$, el = A.el;

const state = { env: "dev", kind: "Deployment" };

function environmentData(env) {
  const overlay = OVERLAYS.find((entry) => entry.name === env) ?? OVERLAYS[0];
  const result = renderOverlay({ chart: CHART, overlay });
  const manifests = result.manifests.map((entry) => entry.manifest);
  const deployment = manifests.find((manifest) => manifest.kind === "Deployment");
  const container = deployment?.spec?.template?.spec?.containers?.[0] ?? {};
  const hpa = manifests.find((manifest) => manifest.kind === "HorizontalPodAutoscaler");
  const pdb = manifests.find((manifest) => manifest.kind === "PodDisruptionBudget");
  return {
    overlay,
    values: result.values,
    namespace: result.namespace,
    manifests,
    deployment,
    container,
    image: container.image,
    replicas: deployment?.spec?.replicas,
    host: result.values.ingress?.host,
    hpa,
    pdb,
  };
}

/* ---------------------------------------------------------------- rendering */

function renderValues(data) {
  $("#overlay-name").textContent = `overlays/${data.overlay.name}`;
  $("#overlay-namespace").textContent = data.namespace;
  $("#overlay-note").textContent = `Rendered from chart values merged with overlays/${data.overlay.name}/values.yaml, then patched.`;
  const rows = [
    ["environment", data.values.environment],
    ["namespace", data.namespace],
    ["image", data.image.split("/").pop()],
    ["replicas", String(data.replicas)],
    ["ingress.host", data.host],
    ["autoscaling", `${data.values.autoscaling.minReplicas}–${data.values.autoscaling.maxReplicas}`],
    ["cpu request", data.values.resources?.requests?.cpu],
    ["memory limit", data.values.resources?.limits?.memory],
    ["log level", data.values.config?.logLevel],
    ["serviceMonitor", data.values.serviceMonitor.enabled ? "enabled" : "off"],
  ];
  $("#values-list").replaceChildren(...rows.map(([key, value]) =>
    el("div", { class: "value-row" },
      el("span", { class: "key", text: key }),
      el("span", { class: "val", title: String(value), text: String(value) }))));

  $("#patch-list").replaceChildren(...Object.keys(data.overlay.patchFiles).map((file) =>
    el("span", { class: "badge", text: file })));
}

function renderKindTabs(data) {
  const kinds = [...new Set(data.manifests.map((manifest) => manifest.kind))];
  if (!kinds.includes(state.kind)) state.kind = kinds.includes("Deployment") ? "Deployment" : kinds[0];
  $("#manifest-count").textContent = `${data.manifests.length} manifests`;
  $("#kind-tabs").replaceChildren(...kinds.map((kind) =>
    el("button", {
      class: `kind-tab ${kind === state.kind ? "active" : ""}`,
      role: "tab",
      text: kind,
      onclick: () => { state.kind = kind; render(); },
    })));
}

function renderManifest(data) {
  const manifest = data.manifests.find((entry) => entry.kind === state.kind);
  $("#manifest-title").textContent = state.kind;
  if (!manifest) {
    $("#manifest-view").textContent = "Manifest is not rendered for this overlay (feature disabled).";
    return;
  }
  $("#manifest-sub").textContent = `${manifest.apiVersion} · ${manifest.kind}/${manifest.metadata.name} · namespace ${manifest.metadata.namespace}`;
  $("#manifest-view").textContent = stringifyYaml(manifest);
  $("#copy-manifest").onclick = () => copy(stringifyYaml(manifest), state.kind);
}

function renderChecks(data) {
  const structural = structuralChecks(data.manifests, {
    namespace: data.namespace,
    environment: data.values.environment,
    image: data.image,
    replicas: data.replicas,
    ingressHost: data.host,
    autoscaling: data.values.autoscaling.enabled,
    pdb: data.values.pdb.enabled,
    serviceMonitor: data.values.serviceMonitor.enabled,
    networkPolicy: data.values.networkPolicy.enabled,
    serviceAccount: data.values.serviceAccount.create,
    secret: data.values.secret.enabled,
  });
  const policies = runPolicyChecks(data.manifests);
  const rows = [];

  rows.push(el("div", { class: "check-section", text: "Manifest structure" }));
  rows.push(...structural.map((check) => el("div", { class: `check-row ${check.status}`, title: check.detail },
    el("span", { class: "check-mark", text: check.status === "pass" ? "✓" : "✕" }),
    el("span", { text: check.name }))));

  rows.push(el("div", { class: "check-section", text: "Policies (conftest equivalent)" }));
  rows.push(...policies.map((check) => el("div", { class: `check-row ${check.status}`, title: check.detail },
    el("span", { class: "check-mark", text: check.status === "pass" ? "✓" : "✕" }),
    el("span", { text: check.rule }),
    el("span", { class: "rule", text: check.status === "pass" ? "pass" : "fail" }))));

  $("#check-list").replaceChildren(...rows);
  const counts = summarise([...structural, ...policies]);
  $("#check-summary").textContent = `${counts.pass}/${counts.total} checks · ${data.manifests.length} manifests`;
  const badge = $("#check-result");
  badge.textContent = counts.fail ? "FAIL" : "PASS";
  badge.className = `badge ${counts.fail ? "red" : "green"}`;
  $("#check-badge").textContent = counts.fail ? "checks failing" : "checks pass";
}

function renderTopology(data) {
  $("#arch-host").textContent = data.host;
  $("#arch-pod").textContent = data.deployment?.metadata.name ?? "—";
  $("#arch-hpa").textContent = data.hpa ? `${data.hpa.spec.minReplicas}–${data.hpa.spec.maxReplicas}` : "off";
  $("#arch-pdb").textContent = data.pdb ? String(data.pdb.spec.minAvailable) : "off";
}

function render() {
  const data = environmentData(state.env);
  document.querySelectorAll("#env-tabs .tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.env === state.env));
  renderValues(data);
  renderKindTabs(data);
  renderManifest(data);
  renderChecks(data);
  renderTopology(data);
}

/* ------------------------------------------------------------------- copy */

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    A.toast(`Copied ${label}`, "success", 1600);
  } catch {
    A.toast("Clipboard is blocked in this browser", "error");
  }
}

/* ---------------------------------------------------------------- routing */

function route() {
  const requested = (location.hash || "#dev").slice(1);
  state.env = OVERLAYS.some((overlay) => overlay.name === requested) ? requested : "dev";
  state.kind = "Deployment";
  render();
  window.scrollTo({ top: 0 });
}

function wire() {
  window.addEventListener("hashchange", route);
}

wire();
route();
