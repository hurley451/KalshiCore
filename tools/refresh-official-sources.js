#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const YAML = require("yaml");
const { spawnSync } = require("child_process");

const root = path.resolve(process.env.KALSHICORE_ROOT || path.resolve(__dirname, ".."));

const sources = [
  {
    id: "kalshi-openapi-rest",
    kind: "openapi",
    url: "https://docs.kalshi.com/openapi.yaml"
  },
  {
    id: "kalshi-asyncapi-websocket",
    kind: "asyncapi",
    url: "https://docs.kalshi.com/asyncapi.yaml"
  },
  {
    id: "kalshi-llms",
    kind: "llms",
    url: "https://docs.kalshi.com/llms.txt"
  }
];

const methodNames = new Set(["get", "post", "put", "patch", "delete"]);

async function fetchText(url, { transport = https, timeoutMs = 30000, maxRedirects = 5 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error("Invalid fetch bounds");
  }
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let settled = false;
    const finish = (error, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        response?.destroy();
        request?.destroy();
        reject(error);
      } else resolve(body);
    };
    // One deadline includes DNS, body transfer, and every redirect hop.
    const timer = setTimeout(() => finish(new Error(`${url}: timeout after ${timeoutMs}ms`)), timeoutMs);
    const visit = (currentUrl, redirects) => {
      try {
        if (new URL(currentUrl).protocol !== "https:") throw new Error(`${currentUrl}: HTTPS required`);
        request = transport.get(currentUrl, (incoming) => {
          if (settled) {
            incoming.destroy();
            return;
          }
          response = incoming;
          incoming.on("error", (error) => finish(error));
          incoming.on("aborted", () => finish(new Error(`${currentUrl}: response aborted`)));
          if (incoming.statusCode >= 300 && incoming.statusCode < 400 && incoming.headers.location) {
            incoming.resume();
            if (redirects >= maxRedirects) {
              finish(new Error(`${url}: redirect limit ${maxRedirects} exceeded`));
              return;
            }
            try {
              visit(new URL(incoming.headers.location, currentUrl).toString(), redirects + 1);
            } catch (error) { finish(error); }
            return;
          }
          if (incoming.statusCode !== 200) {
            incoming.resume();
            finish(new Error(`${currentUrl}: HTTP ${incoming.statusCode}`));
            return;
          }
          incoming.setEncoding("utf8");
          let body = "";
          incoming.on("data", (chunk) => { body += chunk; });
          incoming.on("end", () => finish(null, body));
          incoming.on("close", () => {
            if (!incoming.complete) finish(new Error(`${currentUrl}: incomplete response`));
          });
        });
        request.on("error", (error) => finish(error));
      } catch (error) { finish(error); }
    };
    visit(url, 0);
  });
}

function digest(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function lineCount(text) {
  return text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
}

function byteCount(text) {
  return Buffer.byteLength(text, "utf8");
}

function parseYaml(text, url) {
  try {
    return YAML.parse(text);
  } catch (error) {
    throw new Error(`${url}: ${error.message}`);
  }
}

function extractOpenApiOperations(document) {
  if (!document || typeof document.openapi !== "string" || !document.paths || Array.isArray(document.paths)) {
    throw new Error("Invalid OpenAPI document");
  }
  const resolve = (value, seen = new Set()) => {
    if (!value?.$ref) return value;
    const reference = value.$ref;
    if (!reference.startsWith("#/") || seen.has(reference)) throw new Error(`Unresolvable reference ${reference}`);
    const target = reference.slice(2).split("/").reduce((node, key) =>
      node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], document);
    if (!target) throw new Error(`Missing reference ${reference}`);
    return resolve(target, new Set([...seen, reference]));
  };
  const operations = [];
  const ids = new Set();
  for (const [route, pathItem] of Object.entries(document.paths || {})) {
    const resolvedPath = resolve(pathItem);
    for (const [method, operation] of Object.entries(resolvedPath || {})) {
      if (!methodNames.has(method) || typeof operation !== "object" || operation === null) {
        continue;
      }
      if (typeof operation.operationId !== "string" || !operation.operationId.trim()) {
        throw new Error(`${method.toUpperCase()} ${route}: missing operationId`);
      }
      if (ids.has(operation.operationId)) throw new Error(`Duplicate operationId ${operation.operationId}`);
      ids.add(operation.operationId);
      const parameters = new Map();
      for (const value of [...(resolvedPath.parameters || []), ...(operation.parameters || [])]) {
        const parameter = resolve(value);
        parameters.set(`${parameter.in}:${parameter.name}`, parameter);
      }
      const repeatedQueryParameters = [...parameters.values()].filter((parameter) =>
        parameter.in === "query" && resolve(parameter.schema)?.type === "array" &&
        (parameter.style ?? "form") === "form" && (parameter.explode ?? true) === true
      ).map((parameter) => parameter.name).sort();
      operations.push({
        path: route,
        method: method.toUpperCase(),
        operationId: operation.operationId,
        ...(operation.summary ? { summary: operation.summary } : {}),
        ...(Array.isArray(operation.tags) ? { tags: operation.tags } : {}),
        ...(repeatedQueryParameters.length ? { repeatedQueryParameters } : {})
      });
    }
  }

  operations.sort((left, right) => `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`));
  if (!operations.length) throw new Error("OpenAPI document has no operations");
  return operations;
}

function extractDocsLinks(text) {
  const links = [];
  const expression = /^- \[([^\]]+)]\((https:\/\/docs\.kalshi\.com\/[^)]+)\)(?::\s*(.*))?$/gm;
  let match;
  while ((match = expression.exec(text)) !== null) {
    links.push({
      title: match[1],
      url: match[2],
      ...(match[3] ? { description: match[3] } : {})
    });
  }
  return links;
}

function writeJson(destination, relativePath, value) {
  const absolutePath = path.join(destination, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readReviewedContracts(destination, sourceId, operations, decisions) {
  const endpointDir = path.join(destination, "contracts", "endpoints");
  if (!fs.existsSync(endpointDir)) {
    return new Map();
  }

  const reviewed = new Map();
  const ids = new Set();
  const cited = new Set();
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  for (const fileName of fs.readdirSync(endpointDir).filter((entry) => entry.endsWith(".json")).sort()) {
    const contract = JSON.parse(fs.readFileSync(path.join(endpointDir, fileName), "utf8"));
    const operationId = contract.source?.operationId;
    if (typeof contract.id !== "string" || !contract.id.trim()) throw new Error(`${fileName}: missing contract id`);
    if (ids.has(contract.id)) throw new Error(`Duplicate contract id ${contract.id}`);
    ids.add(contract.id);
    if (operationId) {
      if (cited.has(operationId)) throw new Error(`Duplicate contract operationId ${operationId}`);
      cited.add(operationId);
      const previous = decisions.get(operationId);
      const preserveLiveReview = contract.source.provenance === "observed-live-api" &&
        previous?.status === "reviewed" && previous.contractId === contract.id;
      if (contract.status !== "ready" ||
          (contract.source.provenance !== "official-confirmed" && !preserveLiveReview)) continue;
      const operation = byId.get(operationId);
      if (contract.source.sourceId !== sourceId || !operation || contract.method !== operation.method ||
          contract.path !== `/trade-api/v2${operation.path}`) {
        throw new Error(`Inconsistent reviewed identity for ${operationId}`);
      }
      reviewed.set(operationId, contract.id);
    }
  }
  return reviewed;
}

function buildCoverage(destination, sourceId, operations, generatedAt) {
  const coveragePath = path.join(destination, "contracts/official-coverage.json");
  const previous = fs.existsSync(coveragePath) ? JSON.parse(fs.readFileSync(coveragePath, "utf8")) : null;
  if (previous && previous.sourceId !== sourceId) throw new Error("Inconsistent coverage sourceId");
  const decisions = new Map();
  for (const entry of previous?.operations || []) {
    if (!entry.operationId || decisions.has(entry.operationId)) throw new Error("Missing or duplicate coverage operationId");
    decisions.set(entry.operationId, entry);
  }
  const reviewedContracts = readReviewedContracts(destination, sourceId, operations, decisions);
  const currentIds = new Set(operations.map((operation) => operation.operationId));
  for (const entry of decisions.values()) {
    if (!currentIds.has(entry.operationId) && (entry.status !== "unreviewed" || entry.notes !== undefined || entry.contractId)) {
      throw new Error(`Refresh would erase disposition for ${entry.operationId}`);
    }
  }
  const coverage = operations.map((operation) => {
    const contractId = reviewedContracts.get(operation.operationId);
    const previousEntry = decisions.get(operation.operationId);
    if (previousEntry && (previousEntry.status !== "unreviewed" || previousEntry.notes !== undefined || previousEntry.contractId) &&
        (previousEntry.method !== operation.method || previousEntry.path !== operation.path)) {
      throw new Error(`Inconsistent disposition identity for ${operation.operationId}`);
    }
    if (previousEntry?.status === "reviewed" && (!contractId || previousEntry.contractId !== contractId)) {
      throw new Error(`Inconsistent reviewed identity for ${operation.operationId}`);
    }
    const status = ["future", "irrelevant"].includes(previousEntry?.status) ? previousEntry.status : contractId ? "reviewed" : "unreviewed";
    return {
      operationId: operation.operationId,
      path: operation.path,
      method: operation.method,
      status,
      ...(status === "reviewed" ? { contractId } : previousEntry?.contractId ? { contractId: previousEntry.contractId } : {}),
      ...(previousEntry?.notes !== undefined ? { notes: previousEntry.notes } : {})
    };
  });

  return {
    $schema: "./schemas/official-coverage.schema.json",
    sourceId,
    generatedAt,
    operationCount: coverage.length,
    operations: coverage
  };
}

async function buildSnapshot(destination, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const indexEntries = [];
  const output = new Map();

  for (const source of sources) {
    const text = await fetchText(source.url, options);
    const metadata = {
      id: source.id,
      kind: source.kind,
      url: source.url,
      sha256: digest(text),
      byteCount: byteCount(text),
      lineCount: lineCount(text)
    };

    if (source.kind === "openapi") {
      const document = parseYaml(text, source.url);
      const operations = extractOpenApiOperations(document);
      metadata.version = String(document.info?.version || "");
      metadata.operationCount = operations.length;
      output.set("contracts/official-coverage.json", buildCoverage(destination, source.id, operations, generatedAt));
      output.set("sources/official/rest-openapi-operations.json", {
        $schema: "../schemas/openapi-operations.schema.json",
        sourceId: source.id,
        url: source.url,
        version: metadata.version,
        sha256: metadata.sha256,
        operationCount: operations.length,
        operations
      });
    }

    if (source.kind === "asyncapi") {
      const document = parseYaml(text, source.url);
      if (!document || typeof document.asyncapi !== "string" || !document.channels || typeof document.channels !== "object" || Array.isArray(document.channels)) {
        throw new Error(`${source.url}: invalid AsyncAPI document`);
      }
      metadata.version = String(document.info?.version || "");
      metadata.channelCount = Object.keys(document.channels || {}).length;
    }

    if (source.kind === "llms") {
      const links = extractDocsLinks(text);
      if (!links.length) throw new Error(`${source.url}: no documentation links`);
      metadata.linkCount = links.length;
      output.set("sources/official/docs-links.json", {
        $schema: "../schemas/docs-links.schema.json",
        sourceId: source.id,
        url: source.url,
        sha256: metadata.sha256,
        linkCount: links.length,
        links
      });
    }

    indexEntries.push(metadata);
  }

  output.set("sources/official/kalshi-official-sources.json", {
    $schema: "../schemas/official-source-index.schema.json",
    id: "kalshi-official-sources",
    generatedAt,
    sources: indexEntries
  });
  return output;
}

function validateCandidate(destination) {
  const result = spawnSync(process.execPath, [path.join(__dirname, "validate.js")], {
    env: { ...process.env, KALSHICORE_ROOT: destination }, encoding: "utf8", timeout: 30000
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Candidate validation failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
}

async function refreshSources(destination = root, options = {}) {
  const stage = fs.mkdtempSync(path.join(destination, ".source-refresh-"));
  try {
    for (const directory of ["contracts", "fixtures", "sources", "targets"]) {
      fs.cpSync(path.join(destination, directory), path.join(stage, directory), { recursive: true });
    }
    const output = await buildSnapshot(stage, options);
    const backups = new Map([...output.keys()].map((file) => {
      const original = path.join(stage, file);
      return [file, fs.existsSync(original) ? fs.readFileSync(original) : null];
    }));
    for (const [file, value] of output) writeJson(stage, file, value);
    (options.validate || validateCandidate)(stage);
    // Refuse to replace snapshot files changed by another worker during the fetch.
    for (const [file, backup] of backups) {
      const currentPath = path.join(destination, file);
      const current = fs.existsSync(currentPath) ? fs.readFileSync(currentPath) : null;
      if (backup === null ? current !== null : current === null || !backup.equals(current)) {
        throw new Error(`Snapshot changed during refresh: ${file}`);
      }
    }
    const replaced = [];
    try {
      for (const file of output.keys()) {
        (options.rename || fs.renameSync)(path.join(stage, file), path.join(destination, file));
        replaced.push(file);
      }
      (options.validate || validateCandidate)(destination);
    } catch (error) {
      for (const file of replaced.reverse()) {
        const backup = backups.get(file);
        if (backup === null) fs.rmSync(path.join(destination, file));
        else fs.writeFileSync(path.join(destination, file), backup);
      }
      throw error;
    }
    return output;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function main() {
  const output = await refreshSources();
  const indexEntries = output.get("sources/official/kalshi-official-sources.json").sources;

  for (const source of indexEntries) {
    const detail = source.operationCount ?? source.channelCount ?? source.linkCount;
    console.log(`${source.id}: ${source.sha256}${detail === undefined ? "" : ` (${detail})`}`);
  }
}

module.exports = { fetchText, parseYaml, extractOpenApiOperations, extractDocsLinks, buildCoverage, buildSnapshot, refreshSources, validateCandidate };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
