import test from "node:test";
import assert from "node:assert/strict";
import {
  renderTemplate, extractDefines, mergeValues, parseValues, renderChart,
  renderOverlay, applyJsonPatch, RenderError,
} from "../src/render.js";
import { parseYaml, stringifyYaml } from "../src/yaml.js";

const context = {
  Values: { app: { name: "webapp" }, environment: "prod", enabled: true, disabled: false, replicaCount: 3 },
  Chart: { Name: "k8s-blueprint", Version: "1.0.0" },
  Release: { Name: "webapp", Namespace: "webapp-prod" },
};

test("interpolates values, chart and release fields", () => {
  const out = renderTemplate(
    "name: {{ .Values.app.name }}\nenv: {{ .Values.environment }}\nns: {{ .Release.Namespace }}\nchart: {{ .Chart.Name }}",
    context,
  );
  assert.equal(out, "name: webapp\nenv: prod\nns: webapp-prod\nchart: k8s-blueprint");
});

test("if/else/end controls whole blocks and trims whitespace", () => {
  const template = "a:\n{{- if .Values.enabled }}\n  enabled: yes\n{{- else }}\n  enabled: no\n{{- end }}\nb: true";
  assert.match(renderTemplate(template, context), /enabled: yes/);
  assert.doesNotMatch(renderTemplate(template, context), /enabled: no/);
  const disabled = renderTemplate(template, { ...context, Values: { ...context.Values, enabled: false } });
  assert.match(disabled, /enabled: no/);
});

test("include renders a named define inline", () => {
  const files = {
    "_helpers.tpl": '{{- define "fullname" -}}\n{{ .Values.app.name }}\n{{- end -}}',
  };
  const { defines, files: cleaned } = extractDefines(files);
  assert.equal(cleaned["_helpers.tpl"].trim(), "");
  assert.equal(renderTemplate('name: {{ include "fullname" . }}', context, defines), "name: webapp");
  assert.throws(() => renderTemplate('{{ include "missing" . }}', context, defines), RenderError);
});

test("unclosed blocks and expressions are errors, not empty output", () => {
  assert.throws(() => renderTemplate("{{- if .Values.enabled }}x", context), RenderError);
  assert.throws(() => renderTemplate("{{ .Values.app.name ", context), RenderError);
  assert.throws(() => renderTemplate("{{ .Values.app.name }} {{- end }}", context), RenderError);
  assert.throws(() => renderTemplate("{{ unsupportedFunction x }}", context), RenderError);
});

test("mergeValues is deep for maps and replaces arrays", () => {
  const merged = mergeValues(
    { app: { name: "webapp" }, tags: [1, 2], enabled: true },
    { app: { team: "platform" }, tags: [3], enabled: false },
  );
  assert.deepEqual(merged, { app: { name: "webapp", team: "platform" }, tags: [3], enabled: false });
});

test("JSON 6902 patches add, replace and remove", () => {
  const manifest = {
    apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name: "webapp" },
    spec: { replicas: 2, template: { spec: { containers: [{ name: "app", image: "app:1" }] } } },
  };
  const patched = applyJsonPatch(manifest, [
    { op: "replace", path: "/spec/replicas", value: 5 },
    { op: "replace", path: "/spec/template/spec/containers/0/image", value: "app:2" },
    { op: "add", path: "/metadata/labels", value: { tier: "web" } },
    { op: "remove", path: "/metadata/labels/tier" },
  ]);
  assert.equal(patched.spec.replicas, 5);
  assert.equal(patched.spec.template.spec.containers[0].image, "app:2");
  assert.deepEqual(patched.metadata.labels, {});
  assert.equal(manifest.spec.replicas, 2, "patch must not mutate the input");
});

test("chart rendering returns parsed documents and skips empty files", () => {
  const chart = {
    chartYaml: "name: demo\nversion: 1.0.0\n",
    valuesYaml: "app:\n  name: webapp\nenabled: false\n",
    templates: {
      "_helpers.tpl": '{{- define "name" -}}{{ .Values.app.name }}{{- end -}}',
      "deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ include \"name\" . }}\n",
      "optional.yaml": "{{- if .Values.enabled }}\napiVersion: v1\nkind: Service\nmetadata:\n  name: {{ include \"name\" . }}\n{{- end }}\n",
    },
  };
  const rendered = renderChart({ chart });
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].docs[0].kind, "Deployment");
  assert.equal(rendered[0].docs[0].metadata.name, "webapp");
});

test("stringifyYaml produces YAML that parses back to the same object", () => {
  const manifest = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "webapp", labels: { app: "webapp" } },
    spec: {
      replicas: 2,
      template: {
        spec: {
          containers: [{ name: "app", image: "app:1", resources: { limits: { cpu: "500m" } } }],
        },
      },
      emptyList: [],
    },
  };
  const text = stringifyYaml(manifest);
  assert.deepEqual(parseYaml(text), manifest);
});
