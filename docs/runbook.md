# Runbook

Operational procedures for a service deployed from this blueprint. Commands
assume `kubectl` is pointed at the target cluster and the release is installed in
the namespace for that environment (for example `webapp-prod`).

## Deploy

```bash
# Render first; never apply what you have not looked at.
helm template webapp chart -f overlays/prod/values.yaml --namespace webapp-prod > /tmp/prod.yaml
kubectl diff -f /tmp/prod.yaml

helm upgrade --install webapp chart \
  --namespace webapp-prod --create-namespace \
  -f overlays/prod/values.yaml
```

For Kustomize:

```bash
kubectl apply -k overlays/prod
```

Watch the rollout; `maxUnavailable: 0` means a new pod must become ready before
an old one is removed:

```bash
kubectl -n webapp-prod rollout status deployment/webapp --timeout=180s
```

## Roll back

Helm keeps revision history (`revisionHistoryLimit: 3`):

```bash
helm -n webapp-prod history webapp
helm -n webapp-prod rollback webapp <revision>
```

Kustomize has no revision history. Roll back by reverting the commit that changed
the overlay and re-applying; keep the rendered manifest from the previous release
if audit requirements demand it.

A rollback does not roll back a database migration. If a release included a
schema change, the previous image must still be able to read the current schema;
that is why migrations are expanded before they are contracted.

## Migrations

The chart does not run migrations automatically. Two supported shapes:

1. **Init container** — only for fast, idempotent migrations. It delays pod start
   but keeps the migration tied to the image.
2. **Separate Job from CI** — preferred for anything that takes longer than a
   probe timeout. Run the migration job, wait for completion, then roll the
   Deployment:

```bash
kubectl -n webapp-prod create job migrate-$(date +%s) \
  --image=ghcr.io/arvion/webapp:1.4.0 -- ./migrate up
kubectl -n webapp-prod wait --for=condition=complete job/migrate-... --timeout=600s
```

## Scale

The HPA owns the replica count once installed; editing the Deployment directly is
temporary and will be reverted on the next scaling decision.

```bash
kubectl -n webapp-prod get hpa webapp
kubectl -n webapp-prod describe hpa webapp      # events explain failed scale-ups
```

If pods stay pending during a scale-up, check node capacity and the PodDisruptionBudget
first: `kubectl -n webapp-prod describe pod <pending-pod>`.

## Disruptions and drains

`minAvailable: 1` protects the service from simultaneous voluntary evictions. A
node drain will evict one pod at a time and wait for a replacement to become
ready. If a drain hangs, the PDB is doing its job — check whether replicas are
actually scheduled:

```bash
kubectl -n webapp-prod get pdb webapp
kubectl -n webapp-prod get pods -o wide
```

During a rollout the same budget applies, so `kubectl drain` while a rollout is
in progress can block. Finish the rollout first.

## Probes are failing

Symptom: pods restart, `kubectl get pods` shows `CrashLoopBackOff` or the
Deployment never becomes Available.

1. `kubectl -n webapp-prod describe pod <pod>` — look at the probe failure event
   and the last state.
2. `kubectl -n webapp-prod logs <pod> --previous` — the crashed container's logs.
3. Check the probe path directly from inside the pod:
   `kubectl -n webapp-prod exec <pod> -- wget -qO- localhost:8080/healthz`.

The readiness probe is deliberately separate from liveness: `/readyz` should check
dependencies the pod needs to serve traffic; `/healthz` should check only the
process. A liveness probe that calls the database restarts every pod during a
database outage.

## Network policy

Default ingress is denied and only the ingress-nginx namespace may reach the
container port. If a service that used to reach the pod directly now times out,
the NetworkPolicy is the first suspect:

```bash
kubectl -n webapp-prod get networkpolicy webapp -o yaml
```

Egress is not restricted in this blueprint. That is a known gap: a compromised pod
can still reach the internet and any cluster service that accepts its traffic. Add
egress rules per dependency (DNS, database, object storage) before calling the
policy complete. `docs/architecture.md` lists the intended zones.

## Secrets

The chart renders a placeholder `API_TOKEN`. In a real cluster, replace the
Secret with an external secret and remove `secret.enabled`, or point the chart at
an existing Secret name. Rotate by creating the new value, restarting the
Deployment, then removing the old value; do not edit the Secret in place and
assume pods pick it up — environment variables are read at process start.

```bash
kubectl -n webapp-prod create secret generic webapp --from-literal=API_TOKEN=... --dry-run=client -o yaml | kubectl apply -f -
kubectl -n webapp-prod rollout restart deployment/webapp
```

## Alert checklist

- `kube_deployment_status_replicas_unavailable > 0` for five minutes.
- HPA at `maxReplicas` for ten minutes with CPU above target: capacity problem,
  not a scaling problem.
- NetworkPolicy drops: check the CNI's policy logs if the CNI exposes them.
- Certificate expiry for the ingress secret: `kubectl get secret webapp-tls -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -enddate`.

## What this runbook does not cover

Backup and restore of the application database, cluster upgrades, multi-region
failover and incident communication. Those are environment concerns; this chart
only owns the workload.
