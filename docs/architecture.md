# Architecture

The blueprint deploys one stateless web application. Everything else in the chart
exists to make that workload safe to roll out: a service in front of it, an
ingress for traffic, autoscaling for load, a disruption budget for voluntary
maintenance, a network policy for ingress, a service monitor for metrics, and a
service account without a mounted token.

```
                            ┌─────────────────────────────┐
  client ──► Ingress ──────►│ Service (ClusterIP:80)      │
             nginx class     │ selector: app/instance      │
                            └──────────────┬──────────────┘
                                           │
                            ┌──────────────▼──────────────┐
                            │ Deployment                  │
                            │  replicas: 2 (HPA 2–8)      │
                            │  securityContext non-root   │
                            │  readOnlyRootFilesystem     │
                            │  probes: /healthz /readyz   │
                            └──────────────┬──────────────┘
                                           │
        ┌──────────────────────────────────┼───────────────────────────────┐
        │                                  │                               │
  ┌─────▼───────────────┐        ┌─────────▼────────────┐      ┌───────────▼────────────┐
  │ ConfigMap           │        │ ServiceAccount        │      │ ServiceMonitor         │
  │ APP_ENV, LOG_LEVEL  │        │ no automounted token  │      │ scrapes :http/metrics  │
  └─────────────────────┘        └───────────────────────┘      └────────────────────────┘

  ┌──────────────────────┐      ┌───────────────────────┐      ┌────────────────────────┐
  │ HorizontalPodAutoscaler│     │ PodDisruptionBudget   │      │ NetworkPolicy          │
  │ CPU target 70%        │      │ minAvailable: 1       │      │ ingress from ingress-  │
  └──────────────────────┘      └───────────────────────┘      │ nginx namespace only   │
                                                               └────────────────────────┘
```

## Layers

**Helm chart (`chart/`)** is the source of truth for Kubernetes objects. Values
cover naming, image, replicas, service, ingress, resources, probes, security
context, autoscaling, PDB, NetworkPolicy, ServiceMonitor and the Helm test pod.

**Base (`base/`)** is the chart rendered with default values and committed as
plain manifests. It exists so a team that does not use Helm can run
`kubectl apply -k overlays/dev`; it is regenerated with
`node scripts/render-base.mjs` and the validation script fails if it is stale.

**Overlays (`overlays/<env>/`)** combine two mechanisms:

- `values.yaml` — environment name, log level, ingress host, autoscaling bounds,
  PDB/service monitor switches, resource sizing.
- Kustomize `kustomization.yaml` + JSON 6902 patches — namespace, image tag,
  replica count, ConfigMap values, ingress host and (for prod) HPA bounds.

The validation script renders the chart with each overlay's values, applies the
overlay's JSON patches, and then checks the result. `scripts/validate.sh` also
uses real `helm template` when helm is installed and runs the `conftest` policies
when conftest is present. Neither is required.

## Environment differences

| Setting | dev | staging | prod |
| --- | --- | --- | --- |
| Namespace | `webapp-dev` | `webapp-staging` | `webapp-prod` |
| Replicas (patch) | 1 | 2 | 3 |
| Image tag (patch) | `:dev` | `:staging` | `:1.4.0` |
| `APP_ENV` | `dev` | `staging` | `production` |
| Log level | `debug` | `info` | `warn` |
| HPA | 1–3 | 2–8 | 3–12 |
| CPU request | 100m | 100m | 250m |
| Memory limit | 384Mi | 384Mi | 512Mi |

The image tag and replica count are deliberately patches rather than chart
values: in a GitOps repository they are the two fields a release usually changes,
and keeping them in the overlay makes the diff readable.

## Security posture

- Pod runs as a non-root UID with `seccompProfile: RuntimeDefault`.
- Container filesystem is read-only; the application writes to an `emptyDir` at
  `/tmp`.
- All Linux capabilities are dropped; privilege escalation is disabled.
- No service account token is mounted into the pod.
- NetworkPolicy denies all ingress except traffic from the ingress-nginx
  namespace on the container port. Egress is not restricted — see the runbook.
- Secrets are chart `stringData` placeholders only. Real clusters should use
  External Secrets, Sealed Secrets or a CSI secrets store.

## Files

```
chart/Chart.yaml              chart metadata
chart/values.yaml             documented defaults
chart/templates/              deployment, service, ingress, hpa, pdb, netpol,
                              serviceaccount, secret, servicemonitor, configmap,
                              tests/test-connection.yaml, _helpers.tpl
base/                         chart rendered with defaults (generated)
overlays/{dev,staging,prod}/  values.yaml + kustomization.yaml + JSON patches
policies/*.rego               conftest rules for images, resources, security, probes
scripts/                      validate, render-base, sync-demo
src/                          renderer, checks and YAML parser used by all three
```
