#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const { isDeepStrictEqual } = require("node:util");
const YAML = require("yaml");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { referenceIndex, schemaIndex, restContracts, websocketContracts, compiler, pointer } = require("./full-contracts");
const { requiredCases, assertBehavior, assertOperation } = require("./perps-case-requirements");

const definitions = [
  { id: "perps_openapi", kind: "openapi", sha256: "27e4b0b76a686f797342f1526a08df5b8f60d8104a81b65c94073d3d89b54308", rest: 51, channels: 0, ws: 0 },
  { id: "perps_scm_openapi", kind: "openapi", sha256: "3ac27696d43bffbb5e993daa7106e62872028b7630980a492438d1d0043202e8", rest: 27, channels: 0, ws: 0 },
  { id: "perps_asyncapi", kind: "asyncapi", sha256: "e5cc0f026b8e306e917860b870e23c9152d0d782c33137d42698f051a9dbe824", rest: 0, channels: 8, ws: 22 }
];
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const encode = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const identity = (sourceId, pointer) => ({ sourceId, pointer });
const key = (entry) => `${entry.sourceId}${entry.pointer}`;
const equal = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);
const files = (id) => ({ snapshot: `sources/perps/${id}.yaml`, ledger: `sources/perps/${id}-source.json`,
  inventory: `sources/perps/${id}-inventory.json`, bundle: `contracts/${id}.json`,
  coverage: `contracts/${id}-coverage.json`, fixtures: `fixtures/perps/${id}-cases.json` });

function buildSource(definition, bytes) {
  const { id, kind } = definition;
  assert.equal(hash(bytes), definition.sha256, `${id}: source hash drift`);
  const document = YAML.parse(bytes.toString("utf8"));
  assert.ok(document[kind] && document.components?.schemas, `${id}: invalid source`);
  const paths = files(id);
  const qualify = (entry) => ({ ...entry, identity: identity(id, entry.source) });
  const schemas = schemaIndex(document);
  const references = referenceIndex(document);
  const source = { sourceId: id, url: `https://docs.kalshi.com/${id}.yaml`, sha256: hash(bytes),
    snapshot: paths.snapshot, dialect: document[kind], document, references, schemas };
  const rest = kind === "openapi" ? restContracts(document).map(qualify) : undefined;
  const rawWs = kind === "asyncapi" ? websocketContracts(document) : undefined;
  const websocket = rawWs && { ...rawWs, channels: rawWs.channels.map((channel) => ({ ...qualify(channel),
    messages: channel.messages.map(qualify) })), operations: rawWs.operations.map(qualify), messages: rawWs.messages.map(qualify) };
  const counts = { restOperations: rest?.length || 0, channels: websocket?.channels.length || 0,
    websocketOperations: websocket?.operations.length || 0,
    channelMessages: websocket?.channels.reduce((sum, channel) => sum + channel.messages.length, 0) || 0,
    componentMessages: websocket?.messages.length || 0, schemas: schemas.length, references: references.length,
    responses: rest?.reduce((sum, operation) => sum + operation.responses.length, 0) || 0 };
  assert.deepEqual([counts.restOperations, counts.channels, counts.websocketOperations],
    [definition.rest, definition.channels, definition.ws], `${id}: operation/channel count mismatch`);
  const compile = compiler(document, `urn:kalshicore:${id}`);
  for (const ref of schemas) compile(ref);
  const bundle = { $schema: "./schemas/source-contract-bundle.schema.json", formatVersion: 2,
    provenance: "official-source-imported", sources: { [kind]: source },
    ...(rest ? { rest } : {}), ...(websocket ? { websocket } : {}), counts };
  const gaps = id === "perps_openapi" ? [{ identity: identity(id, rest.find((op) => op.id === "IntraExchangeInstanceTransfer").source),
    issue: "Transfer security declares three separate alternatives; signing scheme descriptions require combined headers. Preserved without correction.",
    status: "unreviewed" }] : [];
  const ledger = { $schema: "../schemas/perps-artifact.schema.json", id, kind,
    url: source.url, sha256: source.sha256, version: String(document.info.version), byteCount: bytes.length,
    lineCount: bytes.toString("utf8").split(/\r?\n/).length - (bytes.at(-1) === 10 ? 1 : 0), counts, gaps };
  const entries = [
    ...(rest || []).map((op, i) => ({ identity: op.identity, operationId: op.id, method: op.method, path: op.path,
      contract: `${id}.json#/rest/${i}`, statuses: op.responses.map((response) => response.status) })),
    ...(websocket?.operations || []).map((op, i) => ({ identity: op.identity, operationId: op.id,
      contract: `${id}.json#/websocket/operations/${i}`, action: op.action, channel: identity(id, op.channel),
      messages: op.messages.map((ref) => identity(id, ref)) })),
    ...(websocket?.channels || []).map((channel, i) => ({ identity: channel.identity, channelId: channel.id,
      contract: `${id}.json#/websocket/channels/${i}` }))
  ];
  const inventory = { $schema: "../schemas/perps-artifact.schema.json", sourceId: id, counts, entries,
    schemas: schemas.map((ref) => identity(id, ref)),
    references: references.map((ref) => ({ at: identity(id, ref.at), target: identity(id, ref.target) })) };
  return { bundle, ledger, inventory };
}

function coverageFor(definition, inventory, previous) {
  const id = definition.id;
  const decisions = new Map((previous?.entries || []).map((entry) => [key(entry.identity), entry.disposition]));
  assert.equal(decisions.size, previous?.entries.length || 0, "Duplicate coverage identity");
  const ids = new Set(inventory.entries.map((entry) => key(entry.identity)));
  for (const entry of decisions.keys()) assert.ok(ids.has(entry), `Coverage would discard ${entry}`);
  return { $schema: "./schemas/source-coverage.schema.json", sourceId: id, sha256: definition.sha256,
    counts: inventory.counts, entries: inventory.entries.map((entry) => ({ identity: entry.identity,
      contract: entry.contract, schemaAccounting: "complete", disposition: decisions.get(key(entry.identity)) || { status: "unreviewed" } })) };
}

function validateCases(bundle, fixture) {
  const source = Object.values(bundle.sources)[0];
  assert.equal(fixture.sourceId, source.sourceId, "Fixture source mismatch");
  const compile = compiler(source.document, `urn:kalshicore:${source.sourceId}`);
  assert.ok(fixture.input.cases.length, "Missing fixture cases");
  const names = new Set();
  const caseIds = new Set();
  const operations = new Set([...(bundle.rest || []), ...(bundle.websocket?.operations || [])].map((entry) => key(entry.identity)));
  const required = new Map(requiredCases(source.sourceId).map((entry) => [entry.name, entry]));
  for (const entry of fixture.input.cases) {
    assert.ok(!names.has(entry.name), "Duplicate fixture case"); names.add(entry.name);
    assert.equal(entry.caseId, `${source.sourceId}:${entry.name}`, "Unstable fixture case identity");
    assert.ok(!caseIds.has(entry.caseId), "Duplicate fixture case identity"); caseIds.add(entry.caseId);
    assert.equal(entry.identity.sourceId, source.sourceId, "Cross-source fixture substitution");
    assert.ok(source.schemas.includes(entry.identity.pointer), "Fixture schema not accounted");
    assert.equal(entry.operation?.sourceId, source.sourceId, "Cross-source fixture operation");
    assert.ok(operations.has(key(entry.operation)), "Fixture operation not accounted");
    const obligation = required.get(entry.name);
    if (obligation) {
      equal(entry.identity, obligation.identity, `${source.sourceId}/${entry.name}: required fixture identity mismatch`);
      equal(entry.operation, obligation.operation, `${source.sourceId}/${entry.name}: required fixture operation mismatch`);
      assert.equal(entry.valid, obligation.valid, `${source.sourceId}/${entry.name}: required fixture polarity mismatch`);
      assertOperation(obligation, source.document);
    }
    const validate = compile(entry.identity.pointer);
    assert.equal(validate(entry.value), entry.valid, `${entry.name}: ${JSON.stringify(validate.errors)}`);
    if (obligation) assertBehavior(obligation, entry, structuredClone(validate.errors || []), validate,
      pointer(source.document, entry.identity.pointer));
  }
  for (const name of required.keys()) assert.ok(names.has(name), `${source.sourceId}: missing required fixture ${name}`);
}

function validatePerps(root) {
  const result = {};
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validators = Object.fromEntries([
    ["bundle", "contracts/schemas/source-contract-bundle.schema.json"],
    ["coverage", "contracts/schemas/source-coverage.schema.json"],
    ["ledger", "sources/schemas/perps-artifact.schema.json"],
    ["inventory", "sources/schemas/perps-artifact.schema.json"],
    ["fixtures", "fixtures/schemas/source-contract-cases.schema.json"]
  ].map(([artifact, file]) => [artifact, ajv.compile(read(root, file))]));
  for (const definition of definitions) {
    const paths = files(definition.id);
    const expected = buildSource(definition, fs.readFileSync(path.join(root, paths.snapshot)));
    for (const [artifact, validate] of Object.entries(validators)) {
      assert.ok(validate(read(root, paths[artifact])), `${definition.id}: ${artifact} shape: ${JSON.stringify(validate.errors)}`);
    }
    for (const artifact of ["bundle", "ledger", "inventory"]) equal(read(root, paths[artifact]), expected[artifact], `${definition.id}: ${artifact} drift`);
    const coverage = read(root, paths.coverage);
    equal(coverage, coverageFor(definition, expected.inventory, coverage), `${definition.id}: coverage drift`);
    // Import accounting cannot promote new contracts to manually reviewed status.
    for (const entry of coverage.entries) assert.equal(entry.disposition.status, "unreviewed", "Imported coverage is not review approval");
    validateCases(expected.bundle, read(root, paths.fixtures));
    result[definition.id] = expected.bundle.counts;
  }
  assert.equal(Object.values(result).reduce((sum, counts) => sum + counts.schemas, 0), 382, "Raw schema root total mismatch");
  return result;
}

function snapshotTree(root) {
  const result = new Map();
  function scan(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile()) result.set(file, fs.readFileSync(path.join(root, file)));
    }
  }
  for (const directory of ["contracts", "sources", "fixtures", "targets"]) if (fs.existsSync(path.join(root, directory))) scan(directory);
  return result;
}

function importPerps(root, inputDir, hooks = {}) {
  const before = snapshotTree(root);
  const output = new Map();
  for (const definition of definitions) {
    const paths = files(definition.id);
    const bytes = fs.readFileSync(path.join(inputDir, `${definition.id}.yaml`));
    const artifacts = buildSource(definition, bytes);
    output.set(paths.snapshot, bytes);
    for (const artifact of ["bundle", "ledger", "inventory"]) output.set(paths[artifact], encode(artifacts[artifact]));
    output.set(paths.coverage, encode(coverageFor(definition, artifacts.inventory,
      before.has(paths.coverage) ? JSON.parse(before.get(paths.coverage)) : null)));
    // Bootstrap explicitly authored cases; preserve and validate existing edits.
    // No example synthesis or schema-derived repair is performed.
    output.set(paths.fixtures, before.get(paths.fixtures) || encode(require("./perps-contract-fixtures.json")[definition.id]));
  }
  const stage = fs.mkdtempSync(path.join(root, ".perps-contract-import-"));
  const replaced = [];
  const createdDirectories = [];
  function parent(file) {
    const directory = path.dirname(file);
    if (!fs.existsSync(directory)) { parent(directory); fs.mkdirSync(directory); createdDirectories.push(directory); }
  }
  try {
    for (const directory of ["contracts", "sources", "fixtures", "targets"]) if (fs.existsSync(path.join(root, directory))) fs.cpSync(path.join(root, directory), path.join(stage, directory), { recursive: true });
    for (const [file, bytes] of output) { fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true }); fs.writeFileSync(path.join(stage, file), bytes); }
    hooks.afterStage?.(stage);
    validatePerps(stage);
    require("./full-contracts").validateFull(stage);
    // Validate the final staged instances and bind replacement to the bytes we
    // built. A changed stage is not a concurrent edit to the real destination.
    for (const [file, bytes] of output) equal(fs.readFileSync(path.join(stage, file)), bytes,
      `Staged artifact changed during import: ${file}`);
    equal(snapshotTree(root), before, "Concurrent edit during import");
    for (const [file, bytes] of output) {
      hooks.beforeReplace?.(file, replaced.length);
      equal(fs.readFileSync(path.join(stage, file)), bytes, `Staged artifact changed during replacement: ${file}`);
      // Check each destination again in case an edit arrived during replacement.
      const current = fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file)) : null;
      equal(current, before.get(file) || null, `Concurrent edit during import: ${file}`);
      parent(path.join(root, file));
      fs.renameSync(path.join(stage, file), path.join(root, file));
      replaced.push([file, bytes]);
    }
    hooks.afterReplace?.();
    const expectedTree = new Map(before);
    for (const [file, bytes] of output) expectedTree.set(file, bytes);
    equal(snapshotTree(root), expectedTree, "Concurrent edit during replacement");
    const result = validatePerps(root);
    require("./full-contracts").validateFull(root);
    equal(snapshotTree(root), expectedTree, "Concurrent edit during post-validation");
    return result;
  } catch (error) {
    for (const [file, bytes] of replaced.reverse()) {
      const destination = path.join(root, file);
      // A concurrent editor's newer contents must survive rollback.
      if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(bytes)) continue;
      if (before.has(file)) fs.writeFileSync(destination, before.get(file));
      else fs.rmSync(destination);
    }
    for (const directory of createdDirectories.reverse()) if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    throw error;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (require.main === module) {
  try {
    const root = path.resolve(process.env.KALSHICORE_ROOT || path.join(__dirname, ".."));
    console.log(JSON.stringify(process.argv[2] === "import" ? importPerps(root, path.resolve(process.argv[3] || "sources/perps")) : validatePerps(root)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { definitions, files, buildSource, coverageFor, validateCases, validatePerps, importPerps, snapshotTree };
