package main

# Every container image must carry a tag, and that tag must not be "latest".
deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not contains(container.image, ":")
  msg := sprintf("%s: image %q has no tag", [input.metadata.name, container.image])
}

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  endswith(container.image, ":latest")
  msg := sprintf("%s: image %q uses latest", [input.metadata.name, container.image])
}
