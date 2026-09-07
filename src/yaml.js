// YAML subset parser for Kubernetes manifests.
//
// Supports block mappings, block sequences whose items are scalars or mappings,
// flow sequences, quoted strings, comments, booleans, numbers and null. Block
// scalars (`|`, `>`) and anchors are rejected on purpose: the chart does not use
// them, and a validator that silently mis-parses them is worse than one that
// refuses.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message);
    this.name = "YamlError";
    this.line = line;
  }
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) return text.slice(0, i);
  }
  return text;
}

function splitFlow(text) {
  const parts = [];
  let quote = null;
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') { current += text[++i] ?? ""; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function parseScalar(raw) {
  const text = raw.trim();
  if (text === "") return null;
  if (/^[&*][^\s]*/.test(text)) throw new YamlError("anchors, aliases and block scalars are not supported");
  if (/^[|>]/.test(text)) throw new YamlError("block scalars are not supported");
  if (text === "{}") return {};
  if (text === "[]") return [];
  if (text.startsWith("[") && text.endsWith("]")) return splitFlow(text.slice(1, -1)).map(parseScalar);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const inner = text.slice(1, -1);
    return text.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  return text;
}

function tokenise(text) {
  const lines = [];
  const raw = String(text).split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const withoutComment = stripComment(raw[i]);
    if (!withoutComment.trim()) continue;
    if (withoutComment.includes("\t")) throw new YamlError("tabs are not valid YAML indentation", i + 1);
    const indent = withoutComment.match(/^ */)[0].length;
    lines.push({ content: withoutComment.trim(), indent, line: i + 1 });
  }
  return lines;
}

function findColon(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ":" && (i === text.length - 1 || text[i + 1] === " " || text[i + 1] === "\t")) return i;
  }
  return -1;
}

function parseBlock(lines, start, indent) {
  return lines[start].content.startsWith("-") ? parseSequence(lines, start, indent) : parseMapping(lines, start, indent);
}

function parseSequence(lines, start, indent) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError("unexpected indentation in sequence", line.line);
    if (!line.content.startsWith("-")) break;
    const rest = line.content.slice(1).trim();
    if (!rest) {
      if (i + 1 >= lines.length || lines[i + 1].indent <= indent) { items.push(null); i++; continue; }
      const [value, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
      items.push(value);
      i = next;
      continue;
    }
    // "- key: value" starts a mapping item; its later keys are indented two
    // spaces past the dash in every manifest we generate.
    const colon = findColon(rest);
    if (colon !== -1 && !rest.startsWith('"') && !rest.startsWith("'") && !/^[\[{]/.test(rest)) {
      const virtual = [];
      const itemIndent = indent + 2;
      virtual.push({ content: rest, indent: itemIndent, line: line.line });
      let j = i + 1;
      while (j < lines.length && lines[j].indent > indent) {
        if (lines[j].indent < itemIndent) break;
        virtual.push(lines[j]);
        j++;
      }
      const [value, consumed] = parseMapping(virtual, 0, itemIndent);
      if (consumed !== virtual.length) throw new YamlError("could not parse sequence mapping item", line.line);
      items.push(value);
      i = j;
      continue;
    }
    items.push(parseScalar(rest));
    i++;
  }
  return [items, i];
}

function parseMapping(lines, start, indent) {
  const object = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError("unexpected indentation in mapping", line.line);
    if (line.content.startsWith("-")) break;
    const colon = findColon(line.content);
    if (colon === -1) throw new YamlError(`expected "key: value", got "${line.content}"`, line.line);
    const key = line.content.slice(0, colon).trim();
    const rest = line.content.slice(colon + 1).trim();
    if (!key) throw new YamlError("empty key", line.line);
    if (rest !== "") {
      object[key] = parseScalar(rest);
      i++;
      continue;
    }
    if (i + 1 < lines.length && lines[i + 1].indent > indent) {
      const [value, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
      object[key] = value;
      i = next;
    } else {
      object[key] = null;
      i++;
    }
  }
  return [object, i];
}

export function parseYaml(text) {
  if (typeof text !== "string") throw new YamlError("parseYaml needs a string");
  const lines = tokenise(text);
  if (!lines.length) return null;
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next !== lines.length) throw new YamlError("could not parse the whole document", lines[next].line);
  return value;
}

/** Parse a multi-document manifest stream (helm output uses `---`). */
export function parseYamlDocuments(text) {
  return String(text)
    .split(/^---\s*$/m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk && !/^#/.test(chunk))
    .map((chunk) => parseYaml(chunk));
}

/* --------------------------------------------------------------- serialiser */

function scalarToYaml(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  const text = String(value);
  if (text === "") return '""';
  if (/^[a-zA-Z0-9_./-]+$/.test(text) && !["true", "false", "null"].includes(text) && !/^[-+]?\d/.test(text)) return text;
  return JSON.stringify(text);
}

function indentLines(text, spaces) {
  const pad = " ".repeat(spaces);
  return text.split("\n").map((line) => (line ? pad + line : line)).join("\n");
}

/** Serialise a parsed manifest back to YAML for display. Stable key order. */
export function stringifyYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return value.map((entry) => {
      if (entry && typeof entry === "object") {
        const body = stringifyYaml(entry, indent + 2);
        return `${pad}- ${body.trimStart()}`;
      }
      return `${pad}- ${scalarToYaml(entry)}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return entries.map(([key, entry]) => {
      if (entry && typeof entry === "object") {
        const isEmptyArray = Array.isArray(entry) && entry.length === 0;
        const isEmptyObject = !Array.isArray(entry) && Object.keys(entry).length === 0;
        if (isEmptyArray) return `${pad}${key}: []`;
        if (isEmptyObject) return `${pad}${key}: {}`;
        return `${pad}${key}:\n${stringifyYaml(entry, indent + 2)}`;
      }
      return `${pad}${key}: ${scalarToYaml(entry)}`;
    }).join("\n");
  }
  return pad + scalarToYaml(value);
}
