#!/usr/bin/env bash
# Validate the Helm chart and every Kustomize overlay.
#
#   ./scripts/validate.sh
#
# The Node validator renders the chart with its own small template engine, so CI
# works without helm or a cluster. If helm is installed, the same values are also
# rendered with the real engine; if conftest is installed, the Rego policies in
# policies/ are run against the result.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/validate.mjs

rendered_dir="$(mktemp -d)"
trap 'rm -rf "$rendered_dir"' EXIT

if command -v helm >/dev/null 2>&1; then
  echo
  echo "helm found, rendering each overlay with the real engine"
  for overlay in overlays/*/; do
    name="$(basename "$overlay")"
    helm template webapp chart -f "${overlay}values.yaml" > "${rendered_dir}/${name}.yaml"
    echo "  ${name}: $(grep -c '^kind:' "${rendered_dir}/${name}.yaml") manifest(s) rendered"
  done

  if command -v conftest >/dev/null 2>&1; then
    echo
    echo "conftest found, running policies/*.rego"
    for file in "${rendered_dir}"/*.yaml; do
      conftest test -p policies "$file" >/dev/null
      echo "  $(basename "$file")  policies ok"
    done
  else
    echo
    echo "conftest not installed, Rego policies were not executed (Node policy checks above did run)"
  fi
else
  echo
  echo "helm not installed, static renderer only (this is the CI path)"
fi
