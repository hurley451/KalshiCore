#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const YAML = require("yaml");
const Ajv = require("ajv");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const bundlePath = "contracts/current-official.json";
const coveragePath = "contracts/current-official-coverage.json";
const kinds = ["openapi", "asyncapi"];
const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const escape = (key) => String(key).replace(/~/g, "~0").replace(/\//g, "~1");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sorted = (object) => Object.entries(object || {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

function pointer(document, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) throw new Error(`Unsupported reference ${ref}`);
  let value = document;
  for (const segment of ref.slice(2).split("/")) {
    const key = decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || !Object.hasOwn(value, key)) throw new Error(`Unresolved reference ${ref}`);
    value = value[key];
  }
  return value;
}

function resolve(document, value, seen = new Set()) {
  if (!value?.$ref) return value;
  if (seen.has(value.$ref)) throw new Error(`Reference object cycle ${value.$ref}`);
  return resolve(document, pointer(document, value.$ref), new Set([...seen, value.$ref]));
}

function walk(value, ref, visit) {
  if (!value || typeof value !== "object") return;
  visit(value, ref);
  for (const [key, child] of Object.entries(value)) walk(child, `${ref}/${escape(key)}`, visit);
}

function referenceIndex(document) {
  const references = [];
  walk(document, "#", (value, at) => {
    if (Object.hasOwn(value, "$ref")) {
      pointer(document, value.$ref);
      references.push({ at: `${at}/$ref`, target: value.$ref });
    }
  });
  return references;
}

function schemaIndex(document) {
  const refs = new Set(sorted(document.components?.schemas).map(([name]) => `#/components/schemas/${escape(name)}`));
  // Examples/defaults are instance data, not schema locations.
  function scan(value, at) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const next = `${at}/${escape(key)}`;
      if (["example", "examples", "default", "enum", "const"].includes(key)) continue;
      if (["schema", "payload", "headers"].includes(key) && child && typeof child === "object" &&
          (key !== "headers" || at.startsWith("#/components/messages/"))) refs.add(next);
      scan(child, next);
    }
  }
  scan(document, "#");
  return [...refs].sort();
}

function mediaContracts(document, value) {
  return sorted(resolve(document, value)?.content).map(([mediaType, media]) => ({
    mediaType, schema: media.schema ?? null, encoding: media.encoding ?? null
  }));
}

function restContracts(document) {
  const ids = new Set();
  const contracts = [];
  for (const [route, rawPath] of sorted(document.paths)) {
    const item = resolve(document, rawPath);
    for (const [method, rawOperation] of sorted(item)) {
      if (!methods.has(method)) continue;
      const operation = resolve(document, rawOperation);
      if (!operation.operationId || ids.has(operation.operationId)) throw new Error(`Missing or duplicate operationId ${operation.operationId}`);
      ids.add(operation.operationId);
      if (!operation.responses || !Object.keys(operation.responses).length) throw new Error(`${operation.operationId}: missing responses`);
      const parameters = new Map();
      for (const parameter of [...(item.parameters || []), ...(operation.parameters || [])]) {
        const resolved = resolve(document, parameter);
        parameters.set(`${resolved.in}:${resolved.name}`, resolved);
      }
      contracts.push({
        id: operation.operationId, method: method.toUpperCase(), path: route,
        source: `#/paths/${escape(route)}/${method}`,
        parameters: [...parameters.values()],
        requestBody: operation.requestBody ? resolve(document, operation.requestBody) : null,
        responses: sorted(operation.responses).map(([status, response]) => ({
          status, contract: resolve(document, response),
          bodies: mediaContracts(document, response),
          bodyDeclaration: resolve(document, response).content ? "declared" : "not-declared-by-source"
        })),
        security: operation.security ?? document.security ?? [],
        servers: operation.servers ?? item.servers ?? document.servers ?? [],
        deprecated: operation.deprecated ?? false
      });
    }
  }
  return contracts;
}

function websocketContracts(document) {
  const messages = sorted(document.components.messages).map(([name, raw]) => {
    const contract = resolve(document, raw);
    if (!contract.payload) throw new Error(`${name}: missing component payload schema`);
    const payload = resolve(document, contract.payload);
    return { name, source: `#/components/messages/${escape(name)}`, contract,
      kind: payload.properties?.cmd ? "command" : "message",
      channelBindings: sorted(document.channels).flatMap(([id, channel]) => sorted(channel.messages)
        .filter(([, value]) => resolve(document, value) === contract)
        .map(([key]) => `#/channels/${escape(id)}/messages/${escape(key)}`)) };
  });
  const operations = sorted(document.operations).map(([id, operation]) => {
    if (!["send", "receive"].includes(operation.action)) throw new Error(`${id}: invalid AsyncAPI action`);
    const channel = pointer(document, operation.channel.$ref);
    if (!operation.messages?.length) throw new Error(`${id}: no typed messages`);
    for (const message of operation.messages) {
      if (!Object.values(channel.messages || {}).some((candidate) =>
        resolve(document, candidate) === resolve(document, pointer(document, message.$ref)))) {
        throw new Error(`${id}: message outside operation channel`);
      }
    }
    return { id, source: `#/operations/${escape(id)}`, action: operation.action,
      channel: operation.channel.$ref, messages: operation.messages.map((message) => message.$ref) };
  });
  const channels = sorted(document.channels).map(([id, channel]) => ({
    id, source: `#/channels/${escape(id)}`, address: channel.address,
    messages: sorted(channel.messages).map(([name, value]) => {
      const message = resolve(document, value);
      if (!message.payload) throw new Error(`${id}/${name}: missing payload schema`);
      const source = `#/channels/${escape(id)}/messages/${escape(name)}`;
      const owners = operations.filter((op) => op.messages.includes(source));
      if (!owners.length) throw new Error(`${source}: message has no operation`);
      return { name, source, contract: message, directions: [...new Set(owners.map((op) => op.action))].sort() };
    }),
    operations: operations.filter((op) => op.channel === `#/channels/${escape(id)}`).map((op) => op.id),
    commandContracts: messages.filter((message) => message.kind === "command").map((message) => message.source),
    commandScope: "Connection commands; channel-specific applicability and constraints are retained in source descriptions."
  }));
  return { channels, operations, messages,
    sourceGaps: messages.filter((message) => !message.channelBindings.length).map((message) => ({
      source: message.source, issue: "Source declares a typed component message without a channel/operation binding." })) };
}

function buildBundle(inputs, index) {
  const sources = {};
  for (const kind of kinds) {
    const bytes = inputs[kind];
    const recorded = index.sources.find((entry) => entry.kind === kind);
    if (!recorded || sha256(bytes) !== recorded.sha256) throw new Error(`${kind}: source hash drift; refresh the source ledger explicitly before importing`);
    const document = YAML.parse(bytes.toString("utf8"));
    if (!document[kind] || !document.components?.schemas) throw new Error(`${kind}: invalid source document`);
    const text = bytes.toString("utf8");
    if (recorded.byteCount !== bytes.length || recorded.version !== String(document.info.version) ||
        recorded.lineCount !== text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0)) throw new Error(`${kind}: source metadata drift`);
    const references = referenceIndex(document);
    sources[kind] = { sourceId: recorded.id, url: recorded.url, sha256: sha256(bytes),
      snapshot: `sources/official/${kind}.yaml`, dialect: document[kind], document,
      references, schemas: schemaIndex(document) };
  }
  const rest = restContracts(sources.openapi.document);
  const websocket = websocketContracts(sources.asyncapi.document);
  if (rest.length !== index.sources.find((entry) => entry.kind === "openapi").operationCount ||
      websocket.channels.length !== index.sources.find((entry) => entry.kind === "asyncapi").channelCount) {
    throw new Error("Source ledger operation/channel count mismatch");
  }
  return { $schema: "./schemas/full-contract-bundle.schema.json", formatVersion: 1,
    provenance: "official-source-imported", sources, rest, websocket,
    counts: { restOperations: rest.length, channels: websocket.channels.length,
      websocketOperations: websocket.operations.length,
      channelMessages: websocket.channels.reduce((sum, channel) => sum + channel.messages.length, 0),
      componentMessages: websocket.messages.length,
      schemas: kinds.reduce((sum, kind) => sum + sources[kind].schemas.length, 0),
      references: kinds.reduce((sum, kind) => sum + sources[kind].references.length, 0) } };
}

function buildCoverage(bundle, ledger, previous = null) {
  const decisions = new Map(ledger.operations.map((op) => [op.operationId, op]));
  if (decisions.size !== ledger.operations.length) throw new Error("Duplicate coverage disposition");
  const wsDecisions = new Map((previous?.channels || []).map((channel) => [channel.id, channel.disposition]));
  const ids = new Set(bundle.rest.map((op) => op.id));
  for (const id of decisions.keys()) if (!ids.has(id)) throw new Error(`Coverage would discard disposition ${id}`);
  const channelIds = new Set(bundle.websocket.channels.map((channel) => channel.id));
  for (const id of wsDecisions.keys()) if (!channelIds.has(id)) throw new Error(`Coverage would discard channel disposition ${id}`);
  return { $schema: "./schemas/full-contract-coverage.schema.json", formatVersion: 1,
    bundle: "current-official.json", sourceHashes: Object.fromEntries(kinds.map((kind) => [kind, bundle.sources[kind].sha256])),
    counts: bundle.counts,
    operations: bundle.rest.map((op, i) => {
      const disposition = decisions.get(op.id);
      if (!disposition || disposition.method !== op.method || disposition.path !== op.path) throw new Error(`${op.id}: coverage identity mismatch`);
      return { id: op.id, contract: `current-official.json#/rest/${i}`, schemaAccounting: "complete",
        disposition, effective: disposition.status === "future" ? "future-disposition" : "present-in-source" };
    }),
    channels: bundle.websocket.channels.map((channel, i) => ({ id: channel.id,
      contract: `current-official.json#/websocket/channels/${i}`, schemaAccounting: "complete",
      disposition: wsDecisions.get(channel.id) || { status: "unreviewed" },
      effective: wsDecisions.get(channel.id)?.status === "future" ? "future-disposition" : "present-in-source" })) };
}

function compiler(document) {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  addFormats(ajv);
  const id = "urn:kalshicore:official";
  // Official OAS uses nullable on both typed schemas and ref/allOf wrappers.
  // Compile a derived view; the bundle retains the exact original constraints.
  function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, ["example", "examples", "default", "enum", "const"].includes(key) ? child : normalize(child)]));
    if (result.nullable === true) {
      delete result.nullable;
      return { anyOf: [result, { type: "null" }],
        ...(Object.hasOwn(result, "enum") ? { enum: result.enum } : {}),
        ...(Object.hasOwn(result, "const") ? { const: result.const } : {}) };
    }
    delete result.nullable;
    return result;
  }
  ajv.addSchema({ ...normalize(document), $id: id }, id);
  return (ref) => {
    const validate = ajv.getSchema(`${id}${ref}`);
    if (!validate) throw new Error(`Schema could not compile ${ref}`);
    return validate;
  };
}

function validateBundle(bundle) {
  for (const kind of kinds) {
    const source = bundle.sources[kind];
    assert.deepEqual(source.references, referenceIndex(source.document), `${kind}: reference accounting mismatch`);
    assert.deepEqual(source.schemas, schemaIndex(source.document), `${kind}: schema accounting mismatch`);
    const compile = compiler(source.document);
    for (const ref of source.schemas) {
      try { compile(ref); } catch (error) { throw new Error(`${kind}${ref}: ${error.message}`); }
    }
  }
  assert.deepEqual(bundle.rest, restContracts(bundle.sources.openapi.document), "REST contract accounting mismatch");
  assert.deepEqual(bundle.websocket, websocketContracts(bundle.sources.asyncapi.document), "WebSocket contract accounting mismatch");
}

function validateFull(root) {
  const bundle = read(root, bundlePath);
  const index = read(root, "sources/official/kalshi-official-sources.json");
  const inputs = Object.fromEntries(kinds.map((kind) => [kind, fs.readFileSync(path.join(root, `sources/official/${kind}.yaml`))]));
  const expected = buildBundle(inputs, index);
  assert.deepEqual(bundle, expected, "Bundle differs from complete pinned source import (content/count/reference drift)");
  validateBundle(bundle);
  const coverage = read(root, coveragePath);
  const fixture = read(root, "fixtures/contracts/current-official-cases.json");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const [document, schemaFile] of [
    [bundle, "contracts/schemas/full-contract-bundle.schema.json"],
    [coverage, "contracts/schemas/full-contract-coverage.schema.json"],
    [fixture, "fixtures/schemas/fixture.schema.json"]
  ]) {
    const validate = ajv.compile(read(root, schemaFile));
    assert.ok(validate(document), `${schemaFile}: ${JSON.stringify(validate.errors)}`);
  }
  assert.deepEqual(coverage, buildCoverage(bundle, read(root, "contracts/official-coverage.json"), coverage), "Coverage contract/disposition/count mismatch");
  const compilers = Object.fromEntries(kinds.map((kind) => [kind, compiler(bundle.sources[kind].document)]));
  for (const entry of fixture.input.cases) {
    const validate = compilers[entry.source](entry.schema);
    assert.equal(validate(entry.value), entry.valid, `${entry.name}: fixture validation differs: ${JSON.stringify(validate.errors)}`);
  }
  return bundle.counts;
}

function importFull(root, inputDir) {
  const ledgerPaths = ["sources/official/kalshi-official-sources.json", "contracts/official-coverage.json"];
  const ledgers = new Map(ledgerPaths.map((file) => [file, fs.readFileSync(path.join(root, file))]));
  const outputPaths = [...kinds.map((kind) => `sources/official/${kind}.yaml`), bundlePath, coveragePath];
  const backups = new Map(outputPaths.map((file) => [file,
    fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file)) : null]));
  const inputs = Object.fromEntries(kinds.map((kind) => [kind, fs.readFileSync(path.join(inputDir, `${kind}.yaml`))]));
  const bundle = buildBundle(inputs, read(root, "sources/official/kalshi-official-sources.json"));
  validateBundle(bundle);
  const previous = backups.get(coveragePath) ? JSON.parse(backups.get(coveragePath).toString("utf8")) : null;
  const coverage = buildCoverage(bundle, read(root, "contracts/official-coverage.json"), previous);
  const output = new Map(kinds.map((kind) => [`sources/official/${kind}.yaml`, inputs[kind]]));
  output.set(bundlePath, encode(bundle));
  output.set(coveragePath, encode(coverage));
  const stage = fs.mkdtempSync(path.join(root, ".full-contract-import-"));
  const replaced = [];
  try {
    for (const directory of ["contracts", "sources", "fixtures"]) fs.cpSync(path.join(root, directory), path.join(stage, directory), { recursive: true });
    for (const [file, bytes] of output) fs.writeFileSync(path.join(stage, file), bytes);
    validateFull(stage);
    for (const [file, backup] of new Map([...backups, ...ledgers])) {
      const current = fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file)) : null;
      if (backup === null ? current !== null : current === null || !backup.equals(current)) throw new Error(`Concurrent edit during import: ${file}`);
    }
    for (const file of output.keys()) {
      fs.renameSync(path.join(stage, file), path.join(root, file));
      replaced.push(file);
    }
    return validateFull(root);
  } catch (error) {
    for (const file of replaced.reverse()) {
      const backup = backups.get(file);
      if (backup === null) fs.rmSync(path.join(root, file));
      else fs.writeFileSync(path.join(root, file), backup);
    }
    throw error;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (require.main === module) {
  try {
    const root = path.resolve(process.env.KALSHICORE_ROOT || path.join(__dirname, ".."));
    const counts = process.argv[2] === "import" ? importFull(root, path.resolve(process.argv[3] || "sources/official")) : validateFull(root);
    console.log(`Full official contracts validated: ${JSON.stringify(counts)}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildBundle, buildCoverage, validateBundle, validateFull, importFull, compiler, pointer, resolve, schemaIndex };
