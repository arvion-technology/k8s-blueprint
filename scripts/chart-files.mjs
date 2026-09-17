// Shared filesystem loader for the chart and overlays, used by the validation
// script, the base renderer and the demo-data generator.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function loadChart(root) {
  const chartDir = join(root, "chart");
  const templates = {};
  for (const file of walk(join(chartDir, "templates"))) {
    templates[relative(join(chartDir, "templates"), file).split("\\").join("/")] = readFileSync(file, "utf8");
  }
  return {
    chart: {
      chartYaml: readFileSync(join(chartDir, "Chart.yaml"), "utf8"),
      valuesYaml: readFileSync(join(chartDir, "values.yaml"), "utf8"),
      templates,
    },
    chartDir,
  };
}

export function loadOverlays(root) {
  const overlayDir = join(root, "overlays");
  return readdirSync(overlayDir)
    .filter((name) => statSync(join(overlayDir, name)).isDirectory())
    .sort()
    .map((name) => {
      const dir = join(overlayDir, name);
      const patchFiles = {};
      for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".yaml") && entry.startsWith("patch-"))) {
        patchFiles[file] = readFileSync(join(dir, file), "utf8");
      }
      return {
        name,
        valuesYaml: readFileSync(join(dir, "values.yaml"), "utf8"),
        kustomizationYaml: readFileSync(join(dir, "kustomization.yaml"), "utf8"),
        patchFiles,
      };
    });
}
