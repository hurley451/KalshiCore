const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("node:child_process");
const { definitions, files, buildSource, validatePerps, importPerps, snapshotTree } = require("./perps-contracts");
const { compiler, pointer, resolve } = require("./full-contracts");
const { requiredCases } = require("./perps-case-requirements");
const root = path.resolve(__dirname, "..");
const read = (directory, file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
const write = (directory, file, value) => fs.writeFileSync(path.join(directory, file), `${JSON.stringify(value, null, 2)}\n`);
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kalshi-perps-test-"));
  for (const name of ["contracts", "sources", "fixtures", "targets"]) fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const inputs = path.join(root, "sources/perps");

function rejectFixture(t, id, mutate, bootstrap = false) {
  const directory = fixture(t);
  const file = files(id).fixtures;
  const cases = read(directory, file);
  mutate(cases);
  write(directory, file, cases);
  const before = snapshotTree(directory);
  assert.throws(() => validatePerps(directory));
  assert.throws(() => importPerps(directory, inputs));
  assert.deepEqual(snapshotTree(directory), before, "rejected staged fixture must retain every prior byte");
  if (bootstrap) {
    // Even replacing the matching bootstrap template cannot redefine coverage.
    const templates = require("./perps-contract-fixtures.json");
    const previous = templates[id];
    templates[id] = structuredClone(cases);
    fs.rmSync(path.join(directory, file));
    const absent = snapshotTree(directory);
    try { assert.throws(() => importPerps(directory, inputs)); }
    finally { templates[id] = previous; }
    assert.deepEqual(snapshotTree(directory), absent, "invalid bootstrap must leave missing destinations missing");
  }
}

for (const definition of definitions) for (const obligation of requiredCases(definition.id)) {
  test(`same-count/name/polarity replacement and matching bootstrap rejected: ${obligation.caseId}`, (t) => {
    rejectFixture(t, definition.id, (fixture) => {
      const original = fixture.input.cases.find((entry) => entry.name === obligation.name);
      const replacement = fixture.input.cases.find((entry) => entry.valid === original.valid &&
        entry.identity.pointer !== original.identity.pointer);
      assert.ok(replacement);
      Object.assign(original, { identity: structuredClone(replacement.identity),
        operation: structuredClone(replacement.operation), value: structuredClone(replacement.value) });
    }, true);
  });
  if (!obligation.valid) test(`negative obligation removal rejected in validation and stage: ${obligation.caseId}`, (t) => {
    rejectFixture(t, definition.id, (fixture) => {
      fixture.input.cases = fixture.input.cases.filter((entry) => entry.name !== obligation.name);
    }, true);
  });
}

const behaviorSubstitutions = [
  ["perps_openapi", "composed-order-negative", (value) => { value.self_trade_prevention_type = "maker"; delete value.client_order_id; }],
  ["perps_openapi", "required-order-negative", (value, cases) => Object.assign(value, structuredClone(cases.find((entry) => entry.name === "composed-order-negative").value))],
  ["perps_openapi", "error-positive", (value) => { delete value.code; delete value.message; }],
  ["perps_openapi", "fills-pagination-positive", (value) => { value.fills = []; }],
  ["perps_openapi", "fills-pagination-negative", (value) => { value.fills = []; value.cursor = 5; }],
  ["perps_openapi", "fills-terminal-positive", (value) => { value.cursor = "next"; }],
  ["perps_openapi", "fills-terminal-negative", (value) => { value.cursor = 5; }],
  ["perps_scm_openapi", "error-negative", (value) => { value.code = 123; value.message = "present"; }],
  ["perps_scm_openapi", "composed-payment-negative", (value) => { value.settlement_execution_time = "2026-10-12T01:00:00Z"; value.funding_time = "invalid"; }],
  ["perps_scm_openapi", "payment-pagination-positive", (value) => { value.payments = []; }],
  ["perps_scm_openapi", "payment-pagination-negative", (value) => { value.payments = []; value.cursor = 5; }],
  ["perps_scm_openapi", "payment-terminal-positive", (value) => { value.cursor = ""; }],
  ["perps_scm_openapi", "pagination-limit-positive", (_, cases) => { cases.find((entry) => entry.name === "pagination-limit-positive").value = 9999; }],
  ["perps_scm_openapi", "pagination-limit-negative", (_, cases) => { cases.find((entry) => entry.name === "pagination-limit-negative").value = 1.5; }],
  ["perps_asyncapi", "root-subscribe-negative", (value) => { value.params.channels = ["trade"]; value.cmd = "invalid"; }],
  ["perps_asyncapi", "control-incoming-negative", (_, cases) => { cases.find((entry) => entry.name === "control-incoming-negative").value = 123; }],
  ["perps_asyncapi", "control-outgoing-negative", (_, cases) => { cases.find((entry) => entry.name === "control-outgoing-negative").value = 123; }],
  ["perps_asyncapi", "data-trade-negative", (value) => { value.msg.taker_side = "bid"; value.msg.ts_ms = "invalid"; }],
  ["perps_asyncapi", "data-trade-timestamp-negative", (value) => { value.msg.ts_ms = 1791763200000; value.msg.taker_side = "invalid"; }]
];
for (const [id, name, mutate] of behaviorSubstitutions) test(`same identity/schema/polarity cannot change behavior: ${id}:${name}`, (t) => {
  rejectFixture(t, id, (fixture) => {
    const entry = fixture.input.cases.find((entry) => entry.name === name);
    mutate(entry.value, fixture.input.cases);
    // Confirm this attack still has the original AJV polarity. Its rejection
    // must come from the independent behavioral obligation, not schema shape.
    const bundle = read(root, files(id).bundle);
    const source = Object.values(bundle.sources)[0];
    assert.equal(compiler(source.document)(entry.identity.pointer)(entry.value), entry.valid);
  }, true);
});

for (const id of definitions.map((entry) => entry.id)) test(`operation substitution and renamed stable identity fail: ${id}`, (t) => {
  rejectFixture(t, id, (fixture) => {
    const bundle = read(root, files(id).bundle);
    const other = (bundle.rest || bundle.websocket.operations).find((entry) => entry.source !== fixture.input.cases[0].operation.pointer);
    fixture.input.cases[0].operation = { sourceId: id, pointer: other.source };
  });
  rejectFixture(t, id, (fixture) => { fixture.input.cases[0].caseId += "-replaced"; });
});

test("metadata gate rejects same-name coverage collapse and negative removal", (t) => {
  for (const id of definitions.map((entry) => entry.id)) {
    const directory = fixture(t), file = files(id).fixtures;
    for (const mutate of [
      (fixture) => { const entry = fixture.input.cases[0]; const other = fixture.input.cases.find((candidate) => candidate.valid && candidate.identity.pointer !== entry.identity.pointer); entry.identity = other.identity; entry.operation = other.operation; entry.value = other.value; },
      (fixture) => { fixture.input.cases = fixture.input.cases.filter((entry) => entry.valid); }
    ]) {
      const cases = read(root, file); mutate(cases); write(directory, file, cases);
      const result = spawnSync(process.execPath, [path.join(root, "tools/validate.js")], { env: { ...process.env, KALSHICORE_ROOT: directory }, encoding: "utf8" });
      assert.notEqual(result.status, 0); assert.match(result.stderr, /Perps contracts/);
    }
  }
});

test("legitimate payload edits, reordering and supplementary cases survive validation and import", (t) => {
  const directory = fixture(t);
  for (const id of definitions.map((entry) => entry.id)) {
    const file = files(id).fixtures, cases = read(directory, file);
    for (const entry of cases.input.cases) {
      if (entry.name === "error-positive") { entry.value.code = "changed_code"; entry.value.message = "Changed authored message"; }
      if (entry.name === "composed-order-positive") { entry.value.price = "15.0000"; entry.value.self_trade_prevention_type = "taker_at_cross"; }
      if (entry.name.endsWith("pagination-positive")) entry.value.cursor = "a different continuation";
      if (entry.name === "composed-payment-positive") entry.value.settlement_execution_time = "2026-10-13T01:00:00Z";
      if (entry.name === "root-subscribe-positive") entry.value.params.channels = ["ticker"];
      if (entry.name === "data-trade-timestamp-positive") entry.value.msg.ts_ms += 1000;
    }
    const supplemental = structuredClone(cases.input.cases[0]);
    supplemental.name = "additional-authored-case"; supplemental.caseId = `${id}:${supplemental.name}`;
    cases.input.cases.push(supplemental); cases.input.cases.reverse(); write(directory, file, cases);
  }
  const before = snapshotTree(directory);
  validatePerps(directory); importPerps(directory, inputs); importPerps(directory, inputs);
  assert.deepEqual(snapshotTree(directory), before);
});

for (const [name, id, mutate, expected] of [
  ["negative cases removed", "perps_asyncapi", (fixture) => { fixture.input.cases = fixture.input.cases.filter((entry) => entry.valid); }, /missing required fixture/],
  ["same identity/polarity coverage replaced", "perps_openapi", (fixture) => { fixture.input.cases.find((entry) => entry.name === "error-positive").value = {}; }, /behavior/],
  ["valid staged payload changed", "perps_scm_openapi", (fixture) => { fixture.input.cases.find((entry) => entry.name === "error-positive").value.message = "Changed during staging"; }, /Staged artifact changed/]
]) test(`final staged fixture mutation rejected before replacement with full rollback: ${name}`, (t) => {
  const directory = fixture(t), before = snapshotTree(directory);
  let replacements = 0;
  assert.throws(() => importPerps(directory, inputs, {
    afterStage(stage) { const file = files(id).fixtures, cases = read(stage, file); mutate(cases); write(stage, file, cases); },
    beforeReplace() { replacements++; }
  }), expected);
  assert.equal(replacements, 0);
  assert.deepEqual(snapshotTree(directory), before);
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith(".perps-contract-import-")), false);
});

for (const absent of [false, true]) test(`fixture changed in stage during replacement rolls back all outputs, initially absent=${absent}`, (t) => {
  const directory = fixture(t);
  if (absent) for (const definition of definitions) for (const file of Object.values(files(definition.id))) fs.rmSync(path.join(directory, file));
  const before = snapshotTree(directory);
  let stageDirectory;
  assert.throws(() => importPerps(directory, inputs, {
    afterStage(stage) { stageDirectory = stage; },
    beforeReplace(file, count) {
      if (count === 10) {
        const target = files("perps_asyncapi").fixtures, cases = read(stageDirectory, target);
        cases.input.cases = cases.input.cases.filter((entry) => entry.valid); write(stageDirectory, target, cases);
      }
    }
  }), /Staged artifact changed during replacement/);
  assert.deepEqual(snapshotTree(directory), before);
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith(".perps-contract-import-")), false);
});

test("three independent sources account every operation/status/ref and compile all 382 raw roots", () => {
  assert.deepEqual(validatePerps(root), {
    perps_openapi: { restOperations: 51, channels: 0, websocketOperations: 0, channelMessages: 0, componentMessages: 0, schemas: 213, references: 457, responses: 236 },
    perps_scm_openapi: { restOperations: 27, channels: 0, websocketOperations: 0, channelMessages: 0, componentMessages: 0, schemas: 120, references: 189, responses: 141 },
    perps_asyncapi: { restOperations: 0, channels: 8, websocketOperations: 22, channelMessages: 22, componentMessages: 22, schemas: 49, references: 152, responses: 0 }
  });
  for (const definition of definitions) {
    const bundle = read(root, files(definition.id).bundle);
    const source = bundle.sources[definition.kind];
    assert.deepEqual(Object.keys(bundle.sources), [definition.kind]);
    assert.equal(Object.hasOwn(bundle, "rest"), definition.kind === "openapi");
    assert.equal(Object.hasOwn(bundle, "websocket"), definition.kind === "asyncapi");
    for (const operation of bundle.rest || []) {
      const raw = pointer(source.document, operation.source);
      assert.equal(raw.operationId, operation.id);
      assert.deepEqual(operation.identity, { sourceId: definition.id, pointer: operation.source });
      assert.deepEqual(operation.responses.map((response) => response.status).sort(), Object.keys(raw.responses).sort());
      for (const response of operation.responses) assert.deepEqual(response.contract, resolve(source.document, raw.responses[response.status]));
    }
    const coverage = read(root, files(definition.id).coverage);
    assert.equal(coverage.entries.length, definition.rest + definition.ws + definition.channels);
    for (const entry of coverage.entries) {
      const [file, ref] = entry.contract.split("#");
      assert.equal(file, `${definition.id}.json`);
      assert.deepEqual(pointer(bundle, `#${ref}`).identity, entry.identity);
      assert.equal(entry.disposition.status, "unreviewed");
    }
  }
});

test("preserves server/auth boundaries, OAuth limitation and transfer discrepancy exactly", () => {
  const trading = read(root, files("perps_openapi").bundle);
  const scm = read(root, files("perps_scm_openapi").bundle);
  for (const bundle of [trading, scm]) {
    const document = bundle.sources.openapi.document;
    for (const operation of bundle.rest) {
      const raw = pointer(document, operation.source);
      assert.deepEqual(operation.security, raw.security ?? document.security ?? []);
      assert.deepEqual(operation.servers, raw.servers ?? document.servers ?? []);
    }
  }
  assert.deepEqual(trading.rest.filter((operation) => operation.security.some((security) => Object.hasOwn(security, "kalshiOauthAccessToken"))).map((operation) => operation.id).sort(), ["GetMarginFills", "GetMarginPositions"]);
  assert.deepEqual(scm.sources.openapi.document.security, [{ kalshiBearer: [] }]);
  assert.match(scm.sources.openapi.document.components.securitySchemes.kalshiBearer.description, /admin_user_id/);
  assert.ok(scm.rest.every((operation) => operation.servers.every((server) => server.url.includes("/klear-api/v1"))));
  const transfer = trading.rest.find((operation) => operation.id === "IntraExchangeInstanceTransfer");
  assert.deepEqual(transfer.security, [{ kalshiAccessKey: [] }, { kalshiAccessSignature: [] }, { kalshiAccessTimestamp: [] }]);
  assert.equal(read(root, files("perps_openapi").ledger).gaps[0].identity.pointer, transfer.source);
});

test("overlapping operation and 26 schema names stay in separate compiler/source contexts", () => {
  const predictions = read(root, "contracts/current-official.json");
  const perps = read(root, files("perps_openapi").bundle);
  assert.deepEqual(predictions.rest.filter((op) => perps.rest.some((other) => op.id === other.id)).map((op) => op.id), ["IntraExchangeInstanceTransfer"]);
  assert.equal(Object.keys(predictions.sources.openapi.document.components.schemas).filter((name) => Object.hasOwn(perps.sources.openapi.document.components.schemas, name)).length, 26);
  const a = compiler({ components: { schemas: { Shared: { const: "predictions" } } } }, "urn:kalshicore:predictions");
  const b = compiler({ components: { schemas: { Shared: { const: "perps" } } } }, "urn:kalshicore:perps");
  assert.equal(a("#/components/schemas/Shared")("perps"), false);
  assert.equal(b("#/components/schemas/Shared")("perps"), true);
});

test("representative composed REST, errors, pagination, WS root/control/data cases execute", () => {
  let count = 0;
  for (const definition of definitions) {
    const cases = read(root, files(definition.id).fixtures).input.cases;
    assert.ok(cases.some((entry) => entry.valid) && cases.some((entry) => !entry.valid));
    count += cases.length;
  }
  assert.equal(count, 30);
  validatePerps(root);
});

test("deterministic reimport preserves every existing Predictions artifact and target byte for byte", (t) => {
  const directory = fixture(t);
  const before = snapshotTree(directory);
  importPerps(directory, inputs);
  assert.deepEqual(snapshotTree(directory), before);
  importPerps(directory, inputs);
  assert.deepEqual(snapshotTree(directory), before);
});

test("initial import bootstraps all absent artifacts and authored fixtures", (t) => {
  const directory = fixture(t);
  const before = snapshotTree(directory);
  for (const definition of definitions) for (const file of Object.values(files(definition.id))) fs.rmSync(path.join(directory, file));
  importPerps(directory, inputs);
  assert.deepEqual(snapshotTree(directory), before);
});

for (const [name, artifact, mutate] of [
  ["REST operation removed", "bundle", (doc) => doc.rest.pop()],
  ["status removed", "bundle", (doc) => doc.rest[0].responses.pop()],
  ["schema accounting removed", "inventory", (doc) => doc.schemas.pop()],
  ["reference accounting removed", "inventory", (doc) => doc.references.pop()],
  ["ledger hash changed", "ledger", (doc) => { doc.sha256 = "0".repeat(64); }],
  ["coverage removed", "coverage", (doc) => doc.entries.pop()],
  ["cross-source coverage substitution", "coverage", (doc) => { doc.entries[0].identity.sourceId = "perps_scm_openapi"; }],
  ["import promoted to reviewed", "coverage", (doc) => { doc.entries[0].disposition.status = "reviewed"; }],
  ["cross-source fixture substitution", "fixtures", (doc) => { doc.input.cases[0].identity.sourceId = "perps_scm_openapi"; }],
  ["fixture expectation inverted", "fixtures", (doc) => { doc.input.cases[0].valid = false; }],
  ["foreign schema pointer", "fixtures", (doc) => { doc.input.cases[0].identity.pointer = "#/components/schemas/GetFillsResponse"; }]
]) test(`rejects ${name}`, (t) => {
  const directory = fixture(t);
  const file = files("perps_openapi")[artifact];
  const doc = read(directory, file); mutate(doc); write(directory, file, doc);
  assert.throws(() => validatePerps(directory));
});

for (const artifact of ["snapshot", "ledger", "inventory", "bundle", "coverage", "fixtures"]) test(`missing ${artifact} fails both source gate and metadata entry point`, (t) => {
  const directory = fixture(t);
  fs.rmSync(path.join(directory, files("perps_scm_openapi")[artifact]));
  assert.throws(() => validatePerps(directory));
  const result = spawnSync(process.execPath, [path.join(root, "tools/validate.js")], { env: { ...process.env, KALSHICORE_ROOT: directory }, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Perps contracts/);
});

test("missing/substituted input fails before writing any output", (t) => {
  const directory = fixture(t);
  const before = snapshotTree(directory);
  const input = fs.mkdtempSync(path.join(os.tmpdir(), "kalshi-perps-input-"));
  t.after(() => fs.rmSync(input, { recursive: true, force: true }));
  fs.copyFileSync(path.join(inputs, "perps_openapi.yaml"), path.join(input, "perps_openapi.yaml"));
  assert.throws(() => importPerps(directory, input), /ENOENT/);
  fs.copyFileSync(path.join(inputs, "perps_openapi.yaml"), path.join(input, "perps_scm_openapi.yaml"));
  assert.throws(() => importPerps(directory, input), /hash drift/);
  assert.deepEqual(snapshotTree(directory), before);
});

for (const initiallyAbsent of [false, true]) for (const failure of ["stage", "replacement", "post-validation"]) test(`rollback ${failure}, outputs initially absent=${initiallyAbsent}`, (t) => {
  const directory = fixture(t);
  if (initiallyAbsent) {
    fs.rmSync(path.join(directory, "sources/perps"), { recursive: true });
    fs.rmSync(path.join(directory, "fixtures/perps"), { recursive: true });
    for (const definition of definitions) for (const artifact of ["bundle", "coverage"]) fs.rmSync(path.join(directory, files(definition.id)[artifact]));
  } else {
    fs.writeFileSync(path.join(directory, files("perps_openapi").snapshot), "old source bytes\n");
  }
  const before = snapshotTree(directory);
  const hooks = {
    afterStage() { if (failure === "stage") throw new Error("injected stage failure"); },
    beforeReplace(file, count) { if (failure === "replacement" && count === 10) throw new Error("injected replacement failure"); },
  };
  if (failure === "post-validation") {
    // Fail the actual post-validation read without editing the destination.
    const readFile = fs.readFileSync;
    let replaced = false;
    let coverageReads = 0;
    hooks.afterReplace = () => { replaced = true; };
    fs.readFileSync = function(file, ...options) {
      if (replaced && path.resolve(String(file)) === path.join(directory, files("perps_asyncapi").coverage) && ++coverageReads === 2) {
        replaced = false;
        throw new Error("injected post-validation failure");
      }
      return readFile.call(fs, file, ...options);
    };
    try { assert.throws(() => importPerps(directory, inputs, hooks), /injected/); }
    finally { fs.readFileSync = readFile; }
  } else assert.throws(() => importPerps(directory, inputs, hooks), /injected/);
  assert.deepEqual(snapshotTree(directory), before);
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith(".perps-contract-import-")), false);
  if (initiallyAbsent) assert.equal(fs.existsSync(path.join(directory, "sources/perps")), false);
  if (initiallyAbsent) assert.equal(fs.existsSync(path.join(directory, "fixtures/perps")), false);
});

for (const file of ["contracts/official-coverage.json", "sources/official/kalshi-official-sources.json", "fixtures/perps/perps_openapi-cases.json", "sources/perps/perps_scm_openapi-source.json"]) test(`concurrent staged edit preserved: ${file}`, (t) => {
  const directory = fixture(t);
  let edited;
  assert.throws(() => importPerps(directory, inputs, { afterStage() {
    edited = Buffer.concat([fs.readFileSync(path.join(directory, file)), Buffer.from("\n")]);
    fs.writeFileSync(path.join(directory, file), edited);
  } }), /Concurrent edit/);
  assert.deepEqual(fs.readFileSync(path.join(directory, file)), edited);
});

test("fixture edits are validated in stage before replacement and remain untouched", (t) => {
  const directory = fixture(t);
  const file = files("perps_openapi").fixtures;
  const doc = read(directory, file); doc.input.cases[0].valid = false; write(directory, file, doc);
  const before = snapshotTree(directory);
  assert.throws(() => importPerps(directory, inputs), /composed-order-positive/);
  assert.deepEqual(snapshotTree(directory), before);
});

test("concurrent edit during replacement rolls back other outputs and preserves newer contents", (t) => {
  const directory = fixture(t);
  const source = files("perps_openapi").snapshot;
  const before = snapshotTree(directory);
  const edit = Buffer.from("concurrent source edit\n");
  assert.throws(() => importPerps(directory, inputs, { beforeReplace(file, count) {
    if (count === 10) fs.writeFileSync(path.join(directory, source), edit);
  } }), /Concurrent edit/);
  before.set(source, edit);
  assert.deepEqual(snapshotTree(directory), before);
});
