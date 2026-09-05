// A Helm template subset renderer.
//
// Helm's templating language is Go templates plus a large function library. This
// chart uses a small, boring subset: value interpolation, if/else/end, include of
// named defines, and whitespace trimming. Implementing that subset keeps the
// repository runnable where helm is not installed, which is exactly the CI
// situation. `scripts/validate.sh` still prefers real `helm template` when it is
// available.
//
// Supported:
//   {{ .Values.path }}  {{ .Chart.Name }}  {{ .Release.Namespace }}
//   {{ include "name" . }}
//   {{- if .Values.flag }} ... {{- else }} ... {{- end }}
//   {{- define "name" }} ... {{- end }}   (collected from _helpers.tpl)
//   whitespace trim markers {{- and -}}

import { parseYaml, parseYamlDocuments } from "./yaml.js";

export class RenderError extends Error {
  constructor(message, template) {
    super(template ? `${message} (template ${template})` : message);
    this.name = "RenderError";
    this.template = template;
  }
}

const DEFINE_PATTERN = /\{\{-?\s*define\s+"([^"]+)"\s*-?\}\}([\s\S]*?)\{\{-?\s*end\s*-?\}\}/g;

/** Pull `define` blocks out of helper files, leaving the rest of the template. */
export function extractDefines(files) {
  const defines = new Map();
  const cleaned = {};
  for (const [path, content] of Object.entries(files)) {
    cleaned[path] = content.replace(DEFINE_PATTERN, (_, name, body) => {
      // Defines are used inline by include, so surrounding newlines would break
      // the YAML line they are interpolated into.
      defines.set(name, body.trim());
      return "";
    });
  }
  return { defines, files: cleaned };
}

function lex(text) {
  const tokens = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("{{", cursor);
    if (open === -1) { tokens.push({ type: "text", value: text.slice(cursor) }); break; }
    if (open > cursor) tokens.push({ type: "text", value: text.slice(cursor, open) });
    const close = text.indexOf("}}", open + 2);
    if (close === -1) throw new RenderError("unclosed template expression");
    let inner = text.slice(open + 2, close);
    const leftTrim = inner.startsWith("-");
    const rightTrim = inner.endsWith("-");
    if (leftTrim) inner = inner.slice(1);
    if (rightTrim) inner = inner.slice(0, -1);
    inner = inner.trim();
    tokens.push({ type: "expr", value: inner, leftTrim, rightTrim });
    cursor = close + 2;
  }
  return tokens;
}

function resolvePath(expr, context) {
  const path = expr.replace(/^\./, "").split(".");
  let value = context;
  for (const key of path) {
    if (value === null || value === undefined) return undefined;
    value = value[key];
  }
  return value;
}

function evaluate(expr, context) {
  const text = expr.trim();
  if (text.startsWith("eq ")) {
    const match = text.match(/^eq\s+(.+?)\s+(?:"([^"]*)"|'([^']*)'|(\S+))$/);
    if (!match) throw new RenderError(`unsupported eq expression: ${expr}`);
    const left = resolvePath(match[1].trim(), context);
    const right = match[2] ?? match[3] ?? (isNaN(Number(match[4])) ? match[4] : Number(match[4]));
    return left === right;
  }
  if (text.startsWith("not ")) return !evaluate(text.slice(4), context);
  if (text.startsWith("include ")) {
    const match = text.match(/^include\s+"([^"]+)"\s+\.$/);
    if (!match) throw new RenderError(`unsupported include expression: ${expr}`);
    return { include: match[1] };
  }
  if (/\s/.test(text)) throw new RenderError(`unsupported template function or expression: ${expr}`);
  return resolvePath(text, context);
}

function stringify(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** Render one template string against a context. */
export function renderTemplate(text, context, defines = new Map(), { name = "" } = {}) {
  const tokens = lex(text);
  const frames = [];
  let out = "";
  let trimNext = false;
  const active = () => frames.every((frame) => frame.active);

  for (const token of tokens) {
    if (token.type === "text") {
      let value = token.value;
      if (trimNext) { value = value.replace(/^[ \t]*\r?\n?/, ""); trimNext = false; }
      if (active()) out += value;
      continue;
    }
    if (token.leftTrim) out = out.replace(/[ \t]*$/, "");
    if (token.rightTrim) trimNext = true;
    const expr = token.value;
    if (expr.startsWith("if ")) {
      const condition = Boolean(evaluate(expr.slice(3), context));
      const parentActive = active();
      frames.push({ parentActive, active: parentActive && condition, taken: condition });
      continue;
    }
    if (expr === "else") {
      const frame = frames[frames.length - 1];
      if (!frame) throw new RenderError("else without if", name);
      frame.active = frame.parentActive && !frame.taken;
      frame.taken = true;
      continue;
    }
    if (expr === "end") {
      if (!frames.length) throw new RenderError("end without if", name);
      frames.pop();
      continue;
    }
    if (expr.startsWith("define ")) throw new RenderError("defines must live in a helper file", name);
    if (!active()) continue;
    if (expr.startsWith("include ")) {
      const { include: defineName } = evaluate(expr, context);
      const body = defines.get(defineName);
      if (body === undefined) throw new RenderError(`unknown template ${defineName}`, name);
      out += renderTemplate(body, context, defines, { name: defineName });
      continue;
    }
    const value = evaluate(expr, context);
    out += stringify(value);
  }
  if (frames.length) throw new RenderError("unclosed if block", name);
  return out;
}

/** Deep merge plain objects; arrays and scalars are replaced. */
export function mergeValues(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override) || typeof base !== "object" || typeof override !== "object") return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = mergeValues(base[key], value);
  }
  return result;
}

export function parseValues(valuesYaml) {
  return parseYaml(valuesYaml) ?? {};
}

/**
 * Render a chart object: { chartYaml, valuesYaml, templates: {relativePath: content} }.
 * Returns [{path, content, docs}]. Empty documents are dropped, which is what
 * Helm does for templates that render whitespace only.
 */
export function renderChart({ chart, values, release = { Name: "webapp", Namespace: "default" } }) {
  const chartMeta = parseYaml(chart.chartYaml) ?? {};
  const merged = values ?? parseValues(chart.valuesYaml);
  const { defines, files } = extractDefines(chart.templates);
  const context = {
    Values: merged,
    Chart: { Name: chartMeta.name, Version: chartMeta.version, AppVersion: chartMeta.appVersion },
    Release: { Name: release.Name, Namespace: release.Namespace },
  };
  const results = [];
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith("_helpers.tpl") || path.endsWith("NOTES.txt")) continue;
    if (!path.endsWith(".yaml") && !path.endsWith(".yml")) continue;
    const rendered = renderTemplate(content, context, defines, { name: path });
    if (!rendered.trim()) continue;
    let docs;
    try {
      docs = parseYamlDocuments(rendered);
    } catch (error) {
      throw new RenderError(`${path}: ${error.message}`, path);
    }
    results.push({ path, content: rendered.trimEnd() + "\n", docs: docs.filter(Boolean) });
  }
  return results;
}

/* ---------------------------------------------------------- kustomize bits */

function getPath(object, path) {
  return path.split("/").slice(1).reduce((value, key) => {
    if (value === undefined || value === null) return undefined;
    return value[Array.isArray(value) ? Number(key) : key];
  }, object);
}

function setPath(object, path, value) {
  const parts = path.split("/").slice(1);
  let cursor = object;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = Array.isArray(cursor) ? Number(parts[i]) : parts[i];
    if (cursor[key] === undefined) cursor[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cursor = cursor[key];
  }
  const last = parts[parts.length - 1];
  cursor[Array.isArray(cursor) ? Number(last) : last] = value;
}

/** Apply RFC 6902 operations to a parsed manifest. */
export function applyJsonPatch(manifest, operations) {
  const clone = JSON.parse(JSON.stringify(manifest));
  for (const operation of operations) {
    const { op, path, value } = operation;
    if (op === "add" || op === "replace") setPath(clone, path, JSON.parse(JSON.stringify(value)));
    else if (op === "remove") {
      const parts = path.split("/").slice(1);
      const key = parts.pop();
      const parent = getPath(clone, "/" + parts.join("/"));
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else {
      throw new RenderError(`unsupported JSON patch op ${op}`);
    }
  }
  return clone;
}

function matchesTarget(manifest, target) {
  if (!target) return true;
  if (target.kind && manifest.kind !== target.kind) return false;
  if (target.name && manifest.metadata?.name !== target.name) return false;
  if (target.namespace && manifest.metadata?.namespace !== target.namespace) return false;
  return true;
}

/**
 * Render an overlay: chart defaults + overlay values, then namespace and JSON
 * patches from the kustomization. The overlay's `resources` entry points at
 * ../../base kustomize, which documents the intended deployment mechanism; the
 * renderer uses the chart directly so helm is not required.
 */
export function renderOverlay({ chart, overlay }) {
  const values = mergeValues(parseValues(chart.valuesYaml), parseYaml(overlay.valuesYaml) ?? {});
  const kustomization = parseYaml(overlay.kustomizationYaml) ?? {};
  const rendered = renderChart({ chart, values, release: { Name: "webapp", Namespace: kustomization.namespace ?? "default" } });
  const namespace = kustomization.namespace ?? "default";
  const patches = (kustomization.patches ?? []).map((entry) => ({
    target: entry.target ?? null,
    operations: typeof entry.patch === "string" ? parseYaml(entry.patch) : parseYaml(overlay.patchFiles?.[entry.path] ?? "[]"),
    path: entry.path ?? null,
  }));

  const manifests = [];
  for (const file of rendered) {
    for (const doc of file.docs) {
      if (!doc || !doc.kind) continue;
      let manifest = JSON.parse(JSON.stringify(doc));
      if (namespace) {
        manifest.metadata = { ...(manifest.metadata ?? {}), namespace };
      }
      for (const patch of patches) {
        if (!matchesTarget(manifest, patch.target)) continue;
        manifest = applyJsonPatch(manifest, patch.operations);
      }
      manifests.push({ source: file.path, manifest });
    }
  }
  return { values, manifests, namespace, kustomization };
}
