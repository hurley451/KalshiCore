const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildBundle, buildCoverage, validateBundle, validateFull, importFull, compiler, pointer } = require("./full-contracts");
const root = path.resolve(__dirname, "..");
const read = (file, directory = root) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
const bundle = read("contracts/current-official.json");
const ledger = read("contracts/official-coverage.json");
const sourceIndex = read("sources/official/kalshi-official-sources.json");
const inputs = Object.fromEntries(["openapi", "asyncapi"].map((kind) => [kind, fs.readFileSync(path.join(root, `sources/official/${kind}.yaml`))]));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kalshi-full-contract-test-"));
  for (const name of ["contracts", "sources", "fixtures"]) fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("all official operations/channels/messages/schemas/references are accounted and compile", () => {
  assert.deepEqual(validateFull(root), { restOperations: 118, channels: 15, websocketOperations: 41,
    channelMessages: 44, componentMessages: 44, schemas: 630, references: 1184 });
  for (const operation of bundle.rest) {
    const source = pointer(bundle.sources.openapi.document, operation.source);
    assert.equal(source.operationId, operation.id);
    assert.deepEqual(operation.responses.map((entry) => entry.status).sort(), Object.keys(source.responses).sort());
    for (const response of operation.responses) {
      assert.deepEqual(response.bodies.map((body) => body.mediaType).sort(), Object.keys(response.contract.content || {}).sort());
    }
  }
  for (const channel of bundle.websocket.channels) {
    assert.equal(channel.messages.length, Object.keys(pointer(bundle.sources.asyncapi.document, channel.source).messages).length);
    assert.equal(channel.commandContracts.length, 9);
    for (const message of channel.messages) assert.ok(message.contract.payload);
  }
  assert.deepEqual(bundle.websocket.sourceGaps.map((gap) => gap.source), ["#/components/messages/updateSubscriptionGetSnapshotCommand"]);
});

test("import is byte deterministic and preserves reviewed fills and manual dispositions", (t) => {
  const directory = fixture(t);
  const manual = fs.readFileSync(path.join(directory, "contracts/endpoints/portfolio.fills.list.json"));
  const previousLedger = fs.readFileSync(path.join(directory, "contracts/official-coverage.json"));
  const before = fs.readFileSync(path.join(directory, "contracts/current-official.json"));
  importFull(directory, path.join(root, "sources/official"));
  assert.deepEqual(fs.readFileSync(path.join(directory, "contracts/current-official.json")), before);
  assert.deepEqual(fs.readFileSync(path.join(directory, "contracts/endpoints/portfolio.fills.list.json")), manual);
  assert.deepEqual(fs.readFileSync(path.join(directory, "contracts/official-coverage.json")), previousLedger);
  const decisions = structuredClone(ledger);
  decisions.operations[0] = { ...decisions.operations[0], status: "future", notes: "Future date: retain manual rationale" };
  const coverage = buildCoverage(bundle, decisions);
  assert.deepEqual(coverage.operations.find((op) => op.id === decisions.operations[0].operationId).disposition, decisions.operations[0]);
  assert.equal(coverage.operations.find((op) => op.id === decisions.operations[0].operationId).effective, "future-disposition");
  const fills = coverage.operations.find((op) => op.id === "GetFills");
  assert.deepEqual(fills.disposition, ledger.operations.find((op) => op.operationId === "GetFills"));
  coverage.channels[0].disposition = { status: "future", notes: "Manual WS disposition", provenance: "manual-review" };
  assert.deepEqual(buildCoverage(bundle, decisions, coverage).channels[0].disposition, coverage.channels[0].disposition);
});

test("representative REST query/body/response/errors and WS typed contracts accept and reject fixtures", () => {
  const compilers = Object.fromEntries(["openapi", "asyncapi"].map((kind) => [kind, compiler(bundle.sources[kind].document)]));
  const cases = read("fixtures/contracts/current-official-cases.json").input.cases;
  assert.equal(cases.length, 20);
  for (const entry of cases) assert.equal(compilers[entry.source](entry.schema)(entry.value), entry.valid, entry.name);
});

test("nullable ref/allOf, required, oneOf exclusivity and numeric constraints remain enforced", () => {
  const doc = { components: { schemas: {
    Value: { type: "integer", minimum: 1, maximum: 3 },
    NullableRef: { $ref: "#/components/schemas/Value", nullable: true },
    NullableAllOf: { allOf: [{ $ref: "#/components/schemas/Value" }], nullable: true },
    NullableEnum: { type: "string", nullable: true, enum: ["yes"] },
    Union: { oneOf: [{ type: "number" }, { type: "integer" }] },
    Both: { allOf: [{ type: "object", required: ["a"] }, { type: "object", required: ["b"] }] },
    Optional: { type: "object", properties: { value: { type: "integer", nullable: true } } },
    Required: { type: "object", required: ["value"], properties: { value: { type: "integer", nullable: true } } }
  } } };
  const compile = compiler(doc);
  for (const name of ["NullableRef", "NullableAllOf"]) {
    const validate = compile(`#/components/schemas/${name}`);
    for (const value of [null, 1, 3]) assert.equal(validate(value), true);
    for (const value of [0, 4, "1", 1.5]) assert.equal(validate(value), false);
  }
  assert.equal(compile("#/components/schemas/NullableEnum")(null), false);
  assert.equal(compile("#/components/schemas/Union")(1), false);
  assert.equal(compile("#/components/schemas/Union")(1.5), true);
  assert.equal(compile("#/components/schemas/Both")({ a: 1 }), false);
  assert.equal(compile("#/components/schemas/Both")({ a: 1, b: 2 }), true);
  assert.equal(compile("#/components/schemas/Optional")({}), true);
  assert.equal(compile("#/components/schemas/Required")({}), false);
  assert.equal(compile("#/components/schemas/Required")({ value: null }), true);
});

const accountingMutations = [
  ["missing REST operation", (doc) => doc.rest.pop()],
  ["missing REST parameter", (doc) => doc.rest.find((op) => op.id === "GetFills").parameters.pop()],
  ["missing request body", (doc) => { doc.rest.find((op) => op.requestBody).requestBody = null; }],
  ["missing success response", (doc) => doc.rest[0].responses.shift()],
  ["missing error response", (doc) => { const op = doc.rest.find((op) => op.responses.some((response) => response.status === "400")); op.responses = op.responses.filter((response) => response.status !== "400"); }],
  ["missing channel", (doc) => doc.websocket.channels.pop()],
  ["missing message", (doc) => doc.websocket.channels[0].messages.pop()],
  ["missing command", (doc) => doc.websocket.operations.shift()],
  ["missing unbound component command", (doc) => { doc.websocket.messages = doc.websocket.messages.filter((message) => message.name !== "updateSubscriptionGetSnapshotCommand"); }],
  ["missing schema", (doc) => doc.sources.openapi.schemas.pop()],
  ["missing reference", (doc) => doc.sources.asyncapi.references.pop()],
  ["invalid reference", (doc) => { doc.sources.openapi.document.components.schemas.GetFillsResponse.properties.fills.items.$ref = "#/components/schemas/Absent"; }],
  ["invalid schema", (doc) => { doc.sources.openapi.document.components.schemas.GetFillsResponse.type = "invalid"; }]
];
for (const [name, mutate] of accountingMutations) test(`rejects ${name}`, () => {
  const changed = structuredClone(bundle);
  mutate(changed);
  assert.throws(() => validateBundle(changed));
});

test("hash drift, source metadata/count drift, duplicate identity and external references fail", () => {
  assert.throws(() => buildBundle({ ...inputs, openapi: Buffer.concat([inputs.openapi, Buffer.from("\n")]) }, sourceIndex), /hash drift/);
  const index = structuredClone(sourceIndex);
  index.sources[0].operationCount++;
  assert.throws(() => buildBundle(inputs, index), /count mismatch/);
  index.sources[0].operationCount--;
  index.sources[0].byteCount++;
  assert.throws(() => buildBundle(inputs, index), /metadata drift/);
  assert.throws(() => pointer({}, "https://example.com/schema"), /Unsupported reference/);
  const changed = structuredClone(bundle);
  const operations = Object.values(changed.sources.openapi.document.paths).flatMap((item) => Object.values(item));
  operations[1].operationId = operations[0].operationId;
  assert.throws(() => validateBundle(changed), /duplicate operationId/);
});

for (const [name, file, mutate] of [
  ["bundle counts", "contracts/current-official.json", (doc) => doc.counts.channels++],
  ["raw required constraint", "contracts/current-official.json", (doc) => doc.sources.openapi.document.components.schemas.GetFillsResponse.required.pop()],
  ["coverage pointer", "contracts/current-official-coverage.json", (doc) => { doc.operations[0].contract = "current-official.json#/rest/999"; }],
  ["reviewed provenance erased", "contracts/current-official-coverage.json", (doc) => { doc.operations.find((op) => op.id === "GetFills").disposition.status = "unreviewed"; }],
  ["missing coverage operation", "contracts/current-official-coverage.json", (doc) => doc.operations.pop()],
  ["missing coverage channel", "contracts/current-official-coverage.json", (doc) => doc.channels.pop()],
  ["missing message count", "contracts/current-official-coverage.json", (doc) => doc.counts.channelMessages--]
]) test(`full validator rejects ${name}`, (t) => {
  const directory = fixture(t);
  const doc = read(file, directory);
  mutate(doc);
  fs.writeFileSync(path.join(directory, file), JSON.stringify(doc));
  assert.throws(() => validateFull(directory));
});

test("failed import preserves outputs and supplied source bytes", (t) => {
  const directory = fixture(t);
  const files = ["contracts/current-official.json", "contracts/current-official-coverage.json", "sources/official/openapi.yaml", "sources/official/asyncapi.yaml"];
  const before = files.map((file) => fs.readFileSync(path.join(directory, file)));
  fs.appendFileSync(path.join(directory, "sources/official/openapi.yaml"), "\n");
  assert.throws(() => importFull(directory, path.join(directory, "sources/official")), /hash drift/);
  for (let i = 0; i < 2; i++) assert.deepEqual(fs.readFileSync(path.join(directory, files[i])), before[i]);
  assert.deepEqual(fs.readFileSync(path.join(directory, files[2])), Buffer.concat([before[2], Buffer.from("\n")]));
  assert.deepEqual(fs.readFileSync(path.join(directory, files[3])), before[3]);
});

for (const failure of ["replacement", "post-validation"]) test(`import rolls back ${failure} failures`, (t) => {
  const directory = fixture(t);
  const files = ["sources/official/openapi.yaml", "sources/official/asyncapi.yaml",
    "contracts/current-official.json", "contracts/current-official-coverage.json"];
  fs.writeFileSync(path.join(directory, files[0]), "previous source bytes\n");
  fs.writeFileSync(path.join(directory, files[2]), "previous bundle bytes\n");
  const before = files.map((file) => fs.readFileSync(path.join(directory, file)));
  const rename = fs.renameSync;
  const readFile = fs.readFileSync;
  let replacements = 0;
  let injected = false;
  fs.renameSync = function(from, to) {
    replacements++;
    if (failure === "replacement" && replacements === 2) {
      injected = true;
      throw new Error("injected replacement failure");
    }
    return rename.call(fs, from, to);
  };
  fs.readFileSync = function(file, ...options) {
    if (failure === "post-validation" && replacements === 4 && !injected &&
        path.resolve(String(file)) === path.join(directory, files[2])) {
      injected = true;
      throw new Error("injected post-validation failure");
    }
    return readFile.call(fs, file, ...options);
  };
  try {
    assert.throws(() => importFull(directory, path.join(root, "sources/official")), /injected/);
  } finally {
    fs.renameSync = rename;
    fs.readFileSync = readFile;
  }
  assert.equal(injected, true);
  for (let i = 0; i < files.length; i++) {
    assert.deepEqual(fs.readFileSync(path.join(directory, files[i])), before[i], files[i]);
  }
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith(".full-contract-import-")), false);
});
