package main

deny[msg] {
  input.kind == "Deployment"
  input.spec.template.spec.securityContext.runAsNonRoot != true
  msg := sprintf("%s: pod securityContext.runAsNonRoot must be true", [input.metadata.name])
}

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  container.securityContext.readOnlyRootFilesystem != true
  msg := sprintf("%s/%s: readOnlyRootFilesystem must be true", [input.metadata.name, container.name])
}

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  container.securityContext.allowPrivilegeEscalation != false
  msg := sprintf("%s/%s: allowPrivilegeEscalation must be false", [input.metadata.name, container.name])
}

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not "ALL" in container.securityContext.capabilities.drop
  msg := sprintf("%s/%s: capabilities.drop must include ALL", [input.metadata.name, container.name])
}

deny[msg] {
  input.kind == "Deployment"
  volume := input.spec.template.spec.volumes[_]
  volume.hostPath
  msg := sprintf("%s: hostPath volume %q is not allowed", [input.metadata.name, volume.name])
}
