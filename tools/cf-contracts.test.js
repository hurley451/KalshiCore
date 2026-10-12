const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { spawnSync, execFileSync } = require("node:child_process");
const Ajv2020 = require("ajv/dist/2020");
const { validateCf, evaluateCase, prepareRequest } = require("./cf-contracts");
const { ids, sourceId, prefix, obligations } = require("./cf-case-requirements");
const root = path.resolve(__dirname, "..");
const fixtureFile = "fixtures/cfbenchmarks/rest-cases.json";
const coverageFile = "contracts/manual-coverage.json";
const endpointFile = "contracts/endpoints/cfbenchmarks.values.json";
const read = (directory, file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
const write = (directory, file, value) => fs.writeFileSync(path.join(directory, file), JSON.stringify(value, null, 2) + "\n");
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function snapshot(directory) {
  const result = {};
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[file] = digest(fs.readFileSync(path.join(directory, file)));
    }
  }
  for (const name of ["contracts", "sources", "fixtures", "targets"]) walk(name);
  return result;
}
function portable(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kalshi-cf-contract-test-"));
  for (const name of ["contracts", "sources", "fixtures", "targets"]) fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function gate(directory) {
  return spawnSync(process.execPath, [path.join(root, "tools/validate.js")], {
    cwd: directory, env: { ...process.env, KALSHICORE_ROOT: directory }, encoding: "utf8"
  });
}
function reject(t, file, mutate, metadataGate = false) {
  const directory = portable(t);
  const doc = read(directory, file);
  mutate(doc, directory);
  write(directory, file, doc);
  const before = snapshot(directory);
  assert.throws(() => validateCf(directory));
  if (metadataGate) {
    const result = gate(directory);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
  }
  assert.deepEqual(snapshot(directory), before, "validation never repairs the staged mutation");
}

test("74 CF contract cases validate portably with zero SDK wire claims", (t) => {
  const directory = portable(t), before = snapshot(directory);
  assert.deepEqual(validateCf(directory), { manualSources: 1, manualEntries: 3, cases: 74, sdkWireExecuted: false });
  const result = gate(directory);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(snapshot(directory), before);
});

for (const required of obligations()) {
  test(`independent behavior rejects same identity/count/polarity replacement: ${required.name}`, (t) => {
    reject(t, fixtureFile, (fixture, directory) => {
      const entry = fixture.input.cases.find((c) => c.caseId === required.caseId);
      const contract = read(directory, `contracts/endpoints/${required.contractId}.json`);
      const facts = read(directory, "sources/manual/cfbenchmarks-rest.json").facts;
      const other = fixture.input.cases.find((c) => c.kind === entry.kind &&
        !isDeepStrictEqual(c.input, entry.input) && c.expected.valid === entry.expected.valid &&
        evaluateCase(c, contract, facts).valid === entry.expected.valid);
      if (other) entry.input = structuredClone(other.input);
      else if (entry.kind === "request") entry.input.queryPairs = [["id", "SUBSTITUTED_INDEX"]];
      else if (entry.kind === "metadata") entry.input.rateCost = { ...entry.input.rateCost, substituted: true };
      else assert.fail("a same-polarity input substitution exists");
      entry.expected = evaluateCase(entry, contract, facts);
      // The replacement is internally consistent and retains its name/identity.
      // Matching the editable fixture expectations cannot redefine the obligation.
      assert.deepEqual(evaluateCase(entry, contract, facts), entry.expected);
      assert.equal(entry.expected.valid, other ? other.expected.valid : true);
    });
  });
  test(`identity and removal rejected with matching coverage: ${required.name}`, (t) => {
    reject(t, fixtureFile, (fixture, directory) => {
      const entry = fixture.input.cases.find((c) => c.caseId === required.caseId);
      const replacement = required.caseId + "-substitute";
      entry.caseId = replacement;
      const coverage = read(directory, coverageFile);
      for (const binding of [...coverage.entries, ...coverage.pendingTargets]) {
        binding.caseIds = binding.caseIds.map((id) => id === required.caseId ? replacement : id);
      }
      write(directory, coverageFile, coverage);
    });
    reject(t, fixtureFile, (fixture, directory) => {
      fixture.input.cases = fixture.input.cases.filter((c) => c.caseId !== required.caseId);
      const coverage = read(directory, coverageFile);
      for (const binding of [...coverage.entries, ...coverage.pendingTargets]) {
        binding.caseIds = binding.caseIds.filter((id) => id !== required.caseId);
      }
      write(directory, coverageFile, coverage);
    });
  });
}

const mutations = [
  ["method", endpointFile, (d) => { d.method = "POST"; }],
  ["auth", endpointFile, (d) => { d.auth = "none"; }],
  ["cost", endpointFile, (d) => { d.rateCost.tokens = 10; }],
  ["bucket", endpointFile, (d) => { d.rateCost.bucket = "Write"; }],
  ["prefix", endpointFile, (d) => { d.request.passthrough.prefix = "/trade-api/v2/"; }],
  ["route", endpointFile, (d) => { d.path = prefix + "history/values"; }],
  ["ignored key", endpointFile, (d) => { d.request.passthrough.query.ignoredKeys = ["includeverification"]; }],
  ["closed queries", endpointFile, (d) => { d.request.passthrough.query.open = false; }],
  ["order policy", endpointFile, (d) => { d.request.passthrough.query.preserve.pop(); }],
  ["signing rule", endpointFile, (d) => { d.request.passthrough.signingPath = "query-inclusive"; }],
  ["missing data", endpointFile, (d) => { d.responses[0].bodySchema.required = []; }],
  ["invented data model", endpointFile, (d) => { d.responses[0].bodySchema.properties.data = { type: "object" }; }],
  ["closed envelope", endpointFile, (d) => { d.responses[0].bodySchema.additionalProperties = false; }],
  ["invented error body", endpointFile, (d) => { d.responses[1].bodySchema = { type: "object", required: ["code"] }; }],
  ["error status", endpointFile, (d) => { d.responses[1].status = 401; }],
  ["OAS operation impersonation", endpointFile, (d) => { d.source.operationId = "GetFills"; }],
  ["manual source", endpointFile, (d) => { d.source.sourceId = "kalshi-openapi"; }],
  ["manual helper identity", endpointFile, (d) => { d.source.manualEntryId = ids[1]; }],
  ["raw source hash", "sources/manual/index.json", (d) => { d.sources[0].rawSha256 = "0".repeat(64); }],
  ["derived source hash", "sources/manual/index.json", (d) => { d.sources[0].factsSha256 = "0".repeat(64); }],
  ["source helper count", "sources/manual/index.json", (d) => { d.sources[0].entryIds.pop(); }],
  ["fixture identity", fixtureFile, (d) => { d.id += "-substitute"; }],
  ["fixture helper binding", fixtureFile, (d) => { d.input.cases[0].identity.manualEntryId = ids[1]; }],
  ["case polarity", fixtureFile, (d) => { d.input.cases[0].expected.valid = false; }],
  ["encoded request", fixtureFile, (d) => { d.input.cases[0].expected.request.pathAndQuery += "&wrong=1"; }],
  ["signature message", fixtureFile, (d) => { d.input.cases[1].expected.signatureMessage += "?id=X"; }],
  ["manual coverage contract", coverageFile, (d) => { d.entries[0].contractId = ids[1]; }],
  ["manual coverage fixture", coverageFile, (d) => { d.entries[0].fixtureId = "rest.response.portfolio-fills-page"; }],
  ["manual coverage case", coverageFile, (d) => { d.entries[0].caseIds.pop(); }],
  ["target identity", coverageFile, (d) => { d.pendingTargets[0].targetId = "csharp.KalshiSharp"; }],
  ["target contract", coverageFile, (d) => { d.pendingTargets[0].contractIds.pop(); }],
  ["target fixture", coverageFile, (d) => { d.pendingTargets[0].fixtureIds = []; }],
  ["target case", coverageFile, (d) => { d.pendingTargets[0].caseIds.pop(); }],
  ["target activation", coverageFile, (d) => { d.pendingTargets[0].status = "active"; }]
];
for (const [name, file, mutate] of mutations) test(`portable main gate rejects ${name}`, (t) => reject(t, file, mutate, true));

test("paired source facts/index hash edits cannot invent provider facts", (t) => {
  for (const mutate of [
    (d) => { d.facts.readTokens = 10; },
    (d) => { d.facts.coinAllowlist = true; },
    (d) => { d.facts.providerCredentials = true; },
    (d) => { d.facts.errorMappings[0].status = 400; },
    (d) => { d.conventions.providerRestriction = true; }
  ]) reject(t, "sources/manual/cfbenchmarks-rest.json", (d, directory) => {
    mutate(d); write(directory, "sources/manual/cfbenchmarks-rest.json", d);
    const index = read(directory, "sources/manual/index.json");
    index.sources[0].factsSha256 = digest(fs.readFileSync(path.join(directory, "sources/manual/cfbenchmarks-rest.json")));
    write(directory, "sources/manual/index.json", index);
  }, true);
});

test("missing CF ledgers and helpers fail without repair", (t) => {
  for (const file of ["sources/manual/index.json", "sources/manual/cfbenchmarks-rest.json", fixtureFile,
    coverageFile, ...ids.map((id) => `contracts/endpoints/${id}.json`)]) {
    const directory = portable(t);
    fs.rmSync(path.join(directory, file));
    const before = snapshot(directory);
    assert.notEqual(gate(directory).status, 0);
    assert.deepEqual(snapshot(directory), before);
  }
});

test("manual ledgers cannot substitute a permissive schema", (t) => {
  for (const file of [coverageFile, "sources/manual/index.json", "sources/manual/cfbenchmarks-rest.json", fixtureFile]) {
    const directory = portable(t), doc = read(directory, file);
    doc.$schema = path.relative(path.dirname(file), "contracts/schemas/contract-inventory.schema.json").split(path.sep).join("/");
    write(directory, file, doc);
    const before = snapshot(directory), result = gate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must reference schema/);
    assert.deepEqual(snapshot(directory), before);
  }
});

test("decoded path construction confines compatible origins and preserves exact queries", () => {
  const contract = read(root, "contracts/endpoints/cfbenchmarks.passthrough.json");
  const pairs = [["id", "SHIBUSD_RTI"], ["id", "UNLISTED_INDEX"], ["value", " +%\u96ea"], ["", ""]];
  for (const origin of ["http://127.0.0.1:43210", "https://proxy.example:8443"]) {
    const result = prepareRequest(contract, { providerPath: "safe/\u96ea +", queryPairs: pairs, credentialsProvided: true }, origin);
    assert.equal(result.valid, true);
    assert.equal(result.request.origin, origin);
    assert.equal(result.request.pathname, prefix + "safe/%E9%9B%AA%20%2B");
    assert.deepEqual([...new URLSearchParams(result.request.pathAndQuery.split("?")[1])], pairs);
    assert.equal(result.request.signingPath, result.request.pathname);
  }
  for (const providerPath of [null, 1, "\ud800", "a\u0085b"]) {
    assert.deepEqual(prepareRequest(contract, { providerPath, queryPairs: [], credentialsProvided: true }),
      { valid: false, dispatches: 0, reason: "provider-path" });
  }
});

test("direct JS sparse query arrays reject before serialization while dense ordered pairs survive", () => {
  const contract = read(root, "contracts/endpoints/cfbenchmarks.passthrough.json");
  const prepare = (queryPairs) => prepareRequest(contract, { providerPath: "values", queryPairs, credentialsProvided: true });
  const inheritedPair = new Array(2);
  Object.setPrototypeOf(inheritedPair, Object.assign(Object.create(Array.prototype), { 0: "id", 1: "X" }));
  const inheritedOuter = new Array(1);
  Object.setPrototypeOf(inheritedOuter, Object.assign(Object.create(Array.prototype), { 0: ["id", "X"] }));
  for (const queryPairs of [
    [["id",,]], [[,"X"]], [new Array(2)], new Array(1),
    [["id", "X"],,], [, ["id", "X"]], [inheritedPair], inheritedOuter,
    [["id", undefined]], [[undefined, "X"]]
  ]) {
    assert.deepEqual(prepare(queryPairs), { valid: false, dispatches: 0, reason: "query-pairs" });
  }
  const pairs = [["id", "X"], ["includeVerification", "anything"], ["id", "Y"], ["other", " +%\u96ea"],
    ["id", "X"], ["", ""], ["IncludeVerification", "false"]];
  const before = structuredClone(pairs);
  const result = prepare(pairs);
  const retained = [["id", "X"], ["id", "Y"], ["other", " +%\u96ea"], ["id", "X"], ["", ""], ["IncludeVerification", "false"]];
  assert.equal(result.valid, true);
  assert.deepEqual(result.request.queryPairs, retained);
  assert.equal(result.request.pathAndQuery, prefix + "values?id=X&id=Y&other=+%2B%25%E9%9B%AA&id=X&=&IncludeVerification=false");
  assert.deepEqual([...new URLSearchParams(result.request.pathAndQuery.split("?")[1])], retained);
  assert.deepEqual(pairs, before);
  const empty = prepare([]);
  assert.equal(empty.valid, true);
  assert.deepEqual(empty.request.queryPairs, []);
  assert.equal(empty.request.pathAndQuery, prefix + "values");
});

test("legacy query fixtures remain valid and ordered string pairs are additive", (t) => {
  const directory = portable(t), file = "fixtures/rest/request-serialization/portfolio-fills-query.json";
  const fixture = read(directory, file);
  delete fixture.input.query;
  fixture.input.queryPairs = [["id", "X"], ["id", "Y"]];
  write(directory, file, fixture);
  assert.equal(gate(directory).status, 0);
  for (const queryPairs of [[["id", 1]], [["id"]], [["id", "X", "Y"]]]) {
    fixture.input.queryPairs = queryPairs; write(directory, file, fixture);
    assert.notEqual(gate(directory).status, 0);
  }
  fixture.input.queryPairs = []; fixture.input.query = { id: "X" }; write(directory, file, fixture);
  assert.notEqual(gate(directory).status, 0);
});

test("positive and negative envelopes retain unknown JSON and open error schemas", () => {
  const contract = read(root, endpointFile);
  const validate = new Ajv2020({ strict: true }).compile(contract.responses[0].bodySchema);
  for (const data of [null, false, 0, "price", [], {}, { points: Array(10000).fill("1.0000000000000000001") }]) {
    assert.equal(validate({ data, newEnvelopeField: true }), true);
  }
  for (const body of [{}, [], null, "data"]) assert.equal(validate(body), false);
  for (const response of contract.responses.slice(1)) {
    const validateError = new Ajv2020({ strict: true }).compile(response.bodySchema);
    for (const body of [null, [], "opaque", { any: { schema: true } }]) assert.equal(validateError(body), true);
  }
});

test("approved baseline raw sources, bundles, dispositions, targets and legacy fixtures retain hashes", () => {
  const baseline = require("./cf-legacy-hashes.json");
  assert.equal(baseline.baseline, "99abf30c3fc818815e99f015299e2f4bcbf62a00");
  for (const [file, expected] of Object.entries(baseline.hashes)) {
    assert.equal(digest(fs.readFileSync(path.join(root, file))), expected, file);
  }
  assert.equal(read(root, "sources/official/rest-openapi-operations.json").operationCount, 118);
  assert.equal(read(root, "sources/perps/perps_openapi-inventory.json").counts.restOperations, 51);
  assert.equal(read(root, "sources/perps/perps_scm_openapi-inventory.json").counts.restOperations, 27);
});

test("suite archive includes manual facts, contracts, cases and independent gate", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kalshi-cf-package-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archive = path.join(directory, "suite.tar.gz"), consumer = path.join(directory, "consumer");
  const before = snapshot(root);
  fs.mkdirSync(consumer);
  execFileSync("tar", ["-czf", archive, "LICENSE", ".github/workflows/release.yml", "package.json", "package-lock.json",
    "contracts", "fixtures", "sources", "targets", "tools"], { cwd: root });
  execFileSync("tar", ["-xzf", archive, "-C", consumer]);
  const install = spawnSync("npm", ["ci", "--ignore-scripts", "--offline"], { cwd: consumer, encoding: "utf8" });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const validate = spawnSync("npm", ["run", "validate"], { cwd: consumer, env: { ...process.env, KALSHICORE_ROOT: consumer }, encoding: "utf8" });
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
  assert.deepEqual(require(path.join(consumer, "tools/cf-contracts")).validateCf(consumer),
    { manualSources: 1, manualEntries: 3, cases: 74, sdkWireExecuted: false });
  assert.deepEqual(snapshot(root), before, "packaging cannot rewrite original contracts");
});
