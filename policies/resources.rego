package main

# Requests and limits are both required; a limit without a request lets the
# scheduler overcommit, and a request without a limit lets one pod starve a node.
deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.requests.cpu
  msg := sprintf("%s/%s: CPU request is missing", [input.metadata.name, container.name])
}

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.requests.memory
  msg := sprintf("%s/%s: memory request is missing", [input.metadata.name, container.name])
}

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.limits.cpu
  msg := sprintf("%s/%s: CPU limit is missing", [input.metadata.name, container.name])
}

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.limits.memory
  msg := sprintf("%s/%s: memory limit is missing", [input.metadata.name, container.name])
}
