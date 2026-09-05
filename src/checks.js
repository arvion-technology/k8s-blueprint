// Validation checks for rendered manifests.
//
// Two layers:
//   runPolicyChecks()      mirrors policies/*.rego (what conftest enforces)
//   structuralChecks()     blueprint-specific expectations: the right kinds are
//                          present, selectors line up, the overlay's image tag and
//                          replica count reached the Deployment, and so on.
//
// Both operate on plain parsed objects, not YAML text, so a manifest with the
// wrong indentation fails to parse before it can pass a regex.

export const POLICY_RULES = Object.freeze([
  "no-latest-image",
  "resource-requests-and-limits",
  "run-as-non-root",
  "read-only-root-filesystem",
  "no-privilege-escalation",
  "no-host-path-volumes",
  "probes-defined",
]);

function containersOf(manifest) {
  const spec = manifest?.kind === "Pod" ? manifest.spec : manifest?.spec?.template?.spec;
  return spec?.containers ?? [];
}

function podSpecOf(manifest) {
  return manifest?.kind === "Pod" ? manifest.spec : manifest?.spec?.template?.spec;
}

function label(map) {
  return map ? Object.keys(map).sort().map((key) => `${key}=${map[key]}`).join(",") : "";
}

/**
 * Run the policy rules across every workload. One failing container fails the
 * rule, and the first offending object is named in the detail.
 */
export function runPolicyChecks(manifests) {
  const workloads = manifests.filter((entry) => ["Deployment", "StatefulSet", "DaemonSet", "Pod"].includes(entry.kind));
  const rows = [];

  const latest = [];
  for (const manifest of workloads) {
    for (const container of containersOf(manifest)) {
      const image = String(container.image ?? "");
      const tag = image.includes("@") ? null : image.includes(":") ? image.split(":").pop() : "missing";
      if (!image || tag === "latest" || tag === "missing") latest.push(`${manifest.kind}/${manifest.metadata?.name}: ${image || "no image"}`);
    }
  }
  rows.push({ rule: "no-latest-image", status: latest.length ? "fail" : "pass", detail: latest[0] ?? "all images carry a tag" });

  const resources = [];
  for (const manifest of workloads) {
    for (const container of containersOf(manifest)) {
      if (!container.resources?.requests?.cpu || !container.resources?.requests?.memory
        || !container.resources?.limits?.cpu || !container.resources?.limits?.memory) {
        resources.push(`${manifest.kind}/${manifest.metadata?.name}/${container.name}`);
      }
    }
  }
  rows.push({ rule: "resource-requests-and-limits", status: resources.length ? "fail" : "pass", detail: resources[0] ?? "all containers declare requests and limits" });

  const notRoot = [];
  for (const manifest of workloads) {
    const pod = podSpecOf(manifest);
    const podNonRoot = pod?.securityContext?.runAsNonRoot === true
      || (typeof pod?.securityContext?.runAsUser === "number" && pod.securityContext.runAsUser > 0);
    for (const container of containersOf(manifest)) {
      const containerNonRoot = container.securityContext?.runAsNonRoot === true
        || (typeof container.securityContext?.runAsUser === "number" && container.securityContext.runAsUser > 0);
      if (!podNonRoot && !containerNonRoot) notRoot.push(`${manifest.kind}/${manifest.metadata?.name}/${container.name}`);
    }
  }
  rows.push({ rule: "run-as-non-root", status: notRoot.length ? "fail" : "pass", detail: notRoot[0] ?? "workloads run as a non-root user" });

  const readOnly = [];
  for (const manifest of workloads) {
    for (const container of containersOf(manifest)) {
      if (container.securityContext?.readOnlyRootFilesystem !== true) readOnly.push(`${manifest.kind}/${manifest.metadata?.name}/${container.name}`);
    }
  }
  rows.push({ rule: "read-only-root-filesystem", status: readOnly.length ? "fail" : "pass", detail: readOnly[0] ?? "root filesystems are read-only" });

  const escalation = [];
  for (const manifest of workloads) {
    for (const container of containersOf(manifest)) {
      if (container.securityContext?.allowPrivilegeEscalation !== false) escalation.push(`${manifest.kind}/${manifest.metadata?.name}/${container.name}`);
    }
  }
  rows.push({ rule: "no-privilege-escalation", status: escalation.length ? "fail" : "pass", detail: escalation[0] ?? "privilege escalation is disabled" });

  const hostPaths = [];
  for (const manifest of workloads) {
    for (const volume of podSpecOf(manifest)?.volumes ?? []) {
      if (volume.hostPath) hostPaths.push(`${manifest.kind}/${manifest.metadata?.name}/${volume.name}`);
    }
  }
  rows.push({ rule: "no-host-path-volumes", status: hostPaths.length ? "fail" : "pass", detail: hostPaths[0] ?? "no hostPath volumes" });

  const missingProbes = [];
  for (const manifest of manifests.filter((entry) => entry.kind === "Deployment")) {
    for (const container of containersOf(manifest)) {
      if (!container.livenessProbe || !container.readinessProbe) missingProbes.push(`${manifest.metadata?.name}/${container.name}`);
    }
  }
  rows.push({ rule: "probes-defined", status: missingProbes.length ? "fail" : "pass", detail: missingProbes[0] ?? "liveness and readiness probes are set" });

  return rows;
}

function find(manifests, kind) {
  return manifests.find((manifest) => manifest.kind === kind) ?? null;
}

function all(manifests, kind) {
  return manifests.filter((manifest) => manifest.kind === kind);
}

/** Blueprint-specific structural expectations for one rendered overlay. */
export function structuralChecks(manifests, {
  namespace,
  environment,
  image,
  replicas,
  ingressHost,
  autoscaling = false,
  pdb = true,
  serviceMonitor = true,
  networkPolicy = true,
  serviceAccount = true,
  secret = true,
} = {}) {
  const rows = [];
  const check = (name, ok, detail = "") => rows.push({ name, status: ok ? "pass" : "fail", detail });

  const deployment = find(manifests, "Deployment");
  check("Deployment rendered", Boolean(deployment));
  check("Service rendered", Boolean(find(manifests, "Service")));
  check("ConfigMap rendered", Boolean(find(manifests, "ConfigMap")));
  check("Ingress rendered", Boolean(find(manifests, "Ingress")));
  check("NetworkPolicy rendered", networkPolicy ? Boolean(find(manifests, "NetworkPolicy")) : !find(manifests, "NetworkPolicy"));
  check("HPA rendered", autoscaling ? Boolean(find(manifests, "HorizontalPodAutoscaler")) : !find(manifests, "HorizontalPodAutoscaler"));
  check("PDB rendered", pdb ? Boolean(find(manifests, "PodDisruptionBudget")) : !find(manifests, "PodDisruptionBudget"));
  check("ServiceMonitor rendered", serviceMonitor ? Boolean(find(manifests, "ServiceMonitor")) : !find(manifests, "ServiceMonitor"));
  check("ServiceAccount rendered", serviceAccount ? Boolean(find(manifests, "ServiceAccount")) : !find(manifests, "ServiceAccount"));
  check("Secret rendered", secret ? Boolean(find(manifests, "Secret")) : !find(manifests, "Secret"));

  check("Every object has apiVersion, kind and a name", manifests.every((manifest) =>
    manifest.apiVersion && manifest.kind && manifest.metadata?.name));

  const namespaced = manifests.filter((manifest) => manifest.kind !== "Namespace");
  check("Overlay namespace applied to every object", namespaced.every((manifest) => manifest.metadata?.namespace === namespace),
    namespaced.find((manifest) => manifest.metadata?.namespace !== namespace)?.metadata?.name ?? "");

  if (deployment) {
    const spec = deployment.spec ?? {};
    const templateLabels = spec.template?.metadata?.labels ?? {};
    check("Deployment replicas match the overlay", spec.replicas === replicas, `expected ${replicas}, got ${spec.replicas}`);
    const container = containersOf(deployment)[0] ?? {};
    check("Container image is the overlay image", container.image === image, `expected ${image}, got ${container.image}`);
    check("Deployment selector matches pod labels", label(spec.selector?.matchLabels) === label(templateLabels),
      `${label(spec.selector?.matchLabels)} vs ${label(templateLabels)}`);
    check("Pod security context is non-root", spec.template?.spec?.securityContext?.runAsNonRoot === true);
    check("Container drops all capabilities", (container.securityContext?.capabilities?.drop ?? []).includes("ALL"));
    check("Liveness and readiness probes exist", Boolean(container.livenessProbe && container.readinessProbe));

    const service = find(manifests, "Service");
    check("Service selector matches the Deployment", service ? label(service.spec?.selector) === label(spec.selector?.matchLabels) : false);

    const configMap = find(manifests, "ConfigMap");
    check("ConfigMap carries the overlay environment", configMap?.data?.APP_ENV === environment,
      `expected ${environment}, got ${configMap?.data?.APP_ENV}`);

    const hpa = find(manifests, "HorizontalPodAutoscaler");
    if (autoscaling && hpa) {
      check("HPA targets the Deployment", hpa.spec?.scaleTargetRef?.name === deployment.metadata?.name);
      check("HPA min replicas is at least 1", (hpa.spec?.minReplicas ?? 0) >= 1);
    }

    const ingress = find(manifests, "Ingress");
    if (ingress) {
      check("Ingress host matches the overlay", ingress.spec?.rules?.[0]?.host === ingressHost,
        `expected ${ingressHost}, got ${ingress.spec?.rules?.[0]?.host}`);
      check("Ingress points at the Service", ingress.spec?.rules?.[0]?.http?.paths?.[0]?.backend?.service?.name === service?.metadata?.name);
    }

    const pdbManifest = find(manifests, "PodDisruptionBudget");
    if (pdb && pdbManifest) check("PDB minAvailable is set", pdbManifest.spec?.minAvailable !== undefined);
    const monitor = find(manifests, "ServiceMonitor");
    if (serviceMonitor && monitor) check("ServiceMonitor selects the Service labels", label(monitor.spec?.selector?.matchLabels) === label(service?.spec?.selector));
    const policy = find(manifests, "NetworkPolicy");
    if (networkPolicy && policy) check("NetworkPolicy restricts ingress", (policy.spec?.policyTypes ?? []).includes("Ingress"));
  }

  const workloads = all(manifests, "Deployment");
  check("Blueprint has exactly one Deployment", workloads.length === 1);
  return rows;
}

export function summarise(rows) {
  return {
    pass: rows.filter((row) => row.status === "pass").length,
    fail: rows.filter((row) => row.status === "fail").length,
    total: rows.length,
  };
}
