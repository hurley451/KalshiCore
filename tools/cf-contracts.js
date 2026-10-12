const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Ajv2020 = require("ajv/dist/2020");
const { sourceId, ids, prefix, mappings, obligations } = require("./cf-case-requirements");

const sourceUrl = "https://docs.kalshi.com/cfbenchmarks/rest-passthrough";
const rawSha256 = "bf0ef09aae3c97542090c17bce999e04441f830e6db390c6d392e67929996b51";
const fixtureId = "cfbenchmarks.rest-cases";
const fixturePath = "fixtures/cfbenchmarks/rest-cases.json";
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const same = (actual, expected, label) => assert.deepEqual(actual, expected, label);
const sorted = (values) => [...values].sort();
const envelopeSchema = { type: "object", required: ["data"], properties: { data: {} }, additionalProperties: true };
const passthrough = (providerPath) => ({ prefix, providerPath, query: {
  representation: "ordered-string-pairs", open: true, ignoredKeys: ["includeVerification"],
  preserve: ["duplicates", "order", "decoded-values"]
}, signingPath: "final-encoded-pathname-without-query" });

// A contract oracle only: prepares expectations and performs no network dispatch.
function prepareRequest(contract, input, origin = "https://external-api.kalshi.com") {
  const invalid = (reason) => ({ valid: false, dispatches: 0, reason });
  const p = input.providerPath;
  if (typeof p !== "string" || !p || /[\\%?#\u0000-\u001f\u007f-\u009f]/.test(p) ||
      /^[a-z][a-z0-9+.-]*:/i.test(p) || p.split("/").some((s) => !s || s === "." || s === "..")) {
    return invalid("provider-path");
  }
  const policy = contract.request.passthrough;
  if (policy.providerPath !== "decoded-relative-segments" && p !== policy.providerPath) return invalid("provider-path");
  let pathname;
  try { pathname = policy.prefix + p.split("/").map(encodeURIComponent).join("/"); }
  catch { return invalid("provider-path"); }
  const url = new URL(pathname, origin);
  if (url.origin !== new URL(origin).origin || url.pathname !== pathname || !url.pathname.startsWith(prefix)) {
    return invalid("confinement");
  }
  if (!Array.isArray(input.queryPairs)) return invalid("query-pairs");
  for (let i = 0; i < input.queryPairs.length; i++) {
    if (!Object.hasOwn(input.queryPairs, i)) return invalid("query-pairs");
    const pair = input.queryPairs[i];
    if (!Array.isArray(pair) || pair.length !== 2 || !Object.hasOwn(pair, 0) || !Object.hasOwn(pair, 1) ||
        typeof pair[0] !== "string" || typeof pair[1] !== "string" ||
        !pair[0].isWellFormed() || !pair[1].isWellFormed()) return invalid("query-pairs");
  }
  if (!input.credentialsProvided) return invalid("credentials");
  const pairs = input.queryPairs.filter(([key]) => !policy.query.ignoredKeys.includes(key));
  const query = new URLSearchParams(pairs).toString();
  return { valid: true, request: { method: contract.method, origin: url.origin, pathname,
    pathAndQuery: pathname + (query ? `?${query}` : ""), queryPairs: pairs, body: null,
    auth: contract.auth, rateCost: contract.rateCost, signingPath: url.pathname } };
}

function evaluateCase(entry, contract, facts) {
  const input = entry.input;
  switch (entry.kind) {
    case "request": return prepareRequest(contract, input);
    case "signing": {
      const signatureMessage = input.timestampMs + input.method + input.pathname;
      return { valid: input.candidateMessage === signatureMessage, signatureMessage };
    }
    case "envelope": {
      const valid = new Ajv2020({ strict: true }).compile(contract.responses.find((r) => r.status === 200).bodySchema)(input.body);
      return valid ? { valid: true, body: structuredClone(input.body) } : { valid: false };
    }
    case "mapping": {
      const mapping = facts.errorMappings.find((m) => m.condition === input.condition);
      return { valid: input.status === mapping.status && input.code === mapping.code,
        mapping: { status: mapping.status, code: mapping.code, upstreamDetail: mapping.upstreamDetail === true } };
    }
    case "error": {
      // Bytes are synthetic preservation vectors. No inferred error-body model.
      const bytes = Buffer.from(input.rawBase64, "base64");
      assert.equal(bytes.toString("base64"), input.rawBase64, "canonical error bytes");
      return { valid: true, preservedResponse: { status: input.status,
        headers: structuredClone(input.headers), rawBase64: bytes.toString("base64") } };
    }
    case "metadata": return { valid: input.method === contract.method && input.auth === contract.auth &&
      input.prefix === contract.request.passthrough.prefix && input.rateCost.bucket === contract.rateCost.bucket &&
      input.rateCost.tokens === contract.rateCost.tokens };
    default: throw new Error(`Unknown CF case kind ${entry.kind}`);
  }
}

function validateCf(root) {
  const index = read(root, "sources/manual/index.json");
  assert.equal(index.sources.length, 1, "manual source inventory");
  const source = index.sources[0];
  same({ id: source.id, kind: source.kind, url: source.url, rawSha256: source.rawSha256,
    factsPath: source.factsPath, hashScope: source.hashScope, entryIds: source.entryIds }, {
    id: sourceId, kind: "kalshi-docs-manual", url: sourceUrl, rawSha256,
    factsPath: "sources/manual/cfbenchmarks-rest.json", hashScope: "derived-file-bytes", entryIds: ids
  }, "manual source identity");
  const bytes = fs.readFileSync(path.join(root, source.factsPath));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), source.factsSha256, "derived facts hash");
  const document = JSON.parse(bytes);
  assert.equal(document.id, sourceId, "manual facts identity");
  assert.equal(document.representation, "derived-facts", "manual facts representation");
  assert.equal(document.url, sourceUrl, "manual facts URL");
  same(document.retrieval, { url: sourceUrl + ".md", observedAt: source.observedAt,
    contentType: "text/markdown; charset=utf-8", bytes: 5987, sha256: rawSha256,
    hashScope: "raw-retrieved-bytes", rawStored: false }, "raw retrieval provenance");
  const facts = document.facts;
  same(facts, { method: "GET", prefix, auth: "api-key", entitlementRequired: true, providerCredentials: false,
    readTokens: 50, examplePaths: ["values", "history/values"], providerPaths: "open", queryKeys: "open",
    ignoredKey: "includeVerification", coinAllowlist: false, signing: "pathname-without-query",
    envelope: "required-data-unknown-json-open-object", errorSchema: "unknown",
    errorMappings: Object.entries(mappings).map(([condition, [status, code]]) => ({ condition, status, code,
      ...(condition === "client" ? { upstreamDetail: true } : {}) })) }, "documented CF facts");
  same(document.conventions, { provenance: "approved-sdk-convention", providerPath: "decoded-relative-segments-encoded-once",
    confinement: "configured-origin-and-fixed-prefix", reject: ["empty-path-or-segment", "leading-or-trailing-slash",
      "dot-segments", "backslash", "percent", "control", "query", "fragment", "url-or-scheme"],
    queryPairs: "ordered-string-pairs-preserve-duplicates-order-decoded-values",
    ignoredKey: "remove-every-exact-includeVerification-pair", invalidInputDispatches: 0, providerRestriction: false },
  "approved SDK conventions");
  const officialSources = read(root, "sources/official/kalshi-official-sources.json").sources;
  assert.ok(!officialSources.some((s) => s.id === sourceId), "manual source cannot collide with OAS source IDs");

  const contracts = new Map();
  ids.forEach((id, i) => {
    const contract = read(root, `contracts/endpoints/${id}.json`);
    const providerPath = ["values", "history/values", "decoded-relative-segments"][i];
    same({ id: contract.id, status: contract.status, method: contract.method, path: contract.path, auth: contract.auth },
      { id, status: "ready", method: "GET", path: prefix + (i === 2 ? "{providerPath}" : providerPath), auth: "api-key" }, "CF route identity");
    same(contract.rateCost, { bucket: "Read", tokens: 50 }, "CF Read cost");
    same(contract.request, { passthrough: passthrough(providerPath) }, "CF passthrough policy");
    same(contract.source, { provenance: "official-confirmed", kind: "kalshi-docs", url: sourceUrl,
      observedAt: source.observedAt, sourceId, manualEntryId: id }, "CF manual source binding (no OAS operationId)");
    same(contract.fixtures, ["../../" + fixturePath], "CF fixture binding");
    same(sorted(contract.responses.map((r) => r.status)), [200, 400, 404, 429, 503], "CF response statuses");
    for (const response of contract.responses) {
      same(response.bodySchema, response.status === 200 ? envelopeSchema : {}, "CF response schema remains open");
    }
    contracts.set(id, contract);
  });
  // A manual entry may neither impersonate an OAS operation nor escape its source.
  for (const file of fs.readdirSync(path.join(root, "contracts/endpoints"))) {
    if (!file.endsWith(".json")) continue;
    const contract = read(root, "contracts/endpoints/" + file);
    if (contract.source?.manualEntryId || contract.source?.sourceId === sourceId || contract.request?.passthrough) {
      assert.ok(ids.includes(contract.id), "unregistered manual CF contract");
      assert.equal(file, contract.id + ".json", "manual contract file identity");
    }
  }

  const fixture = read(root, fixturePath);
  assert.equal(fixture.id, fixtureId, "CF fixture identity");
  const cases = fixture.input.cases;
  const required = obligations();
  same(sorted(cases.map((c) => c.caseId)), sorted(required.map((r) => r.caseId)), "CF case identity inventory");
  for (const requirement of required) {
    const entry = cases.find((c) => c.caseId === requirement.caseId);
    same({ name: entry.name, kind: entry.kind, identity: entry.identity }, {
      name: requirement.name, kind: requirement.kind,
      identity: { sourceId, manualEntryId: requirement.contractId }
    }, `${requirement.caseId}: behavioral identity binding`);
    requirement.check(entry.input);
    same(evaluateCase(entry, contracts.get(requirement.contractId), facts), entry.expected,
      `${requirement.caseId}: contract expectation`);
  }

  const coverage = read(root, "contracts/manual-coverage.json");
  assert.equal(coverage.sourceId, sourceId, "manual coverage source");
  assert.equal(coverage.fixtureId, fixtureId, "manual coverage fixture");
  same(coverage.entries, ids.map((id) => ({ manualEntryId: id, contractId: id, fixtureId,
    caseIds: required.filter((r) => r.contractId === id).map((r) => r.caseId) })), "manual coverage case bindings");
  const targetFiles = ["targets/typescript/KalshiTS.json", "targets/rust/kalshi-rs.json"];
  const targetIds = ["typescript.KalshiTS", "rust.kalshi-rs"];
  same(coverage.pendingTargets, targetIds.map((targetId) => ({ targetId, status: "pending-sdk-support",
    contractIds: ids, fixtureIds: [fixtureId], caseIds: required.map((r) => r.caseId) })), "pending target case bindings");
  targetFiles.forEach((file, i) => assert.equal(read(root, file).id, targetIds[i], "pending target identity"));
  return { manualSources: 1, manualEntries: ids.length, cases: required.length, sdkWireExecuted: false };
}

module.exports = { validateCf, prepareRequest, evaluateCase };
if (require.main === module) {
  console.log("CF manual contracts validated:", JSON.stringify(validateCf(path.resolve(process.env.KALSHICORE_ROOT || path.join(__dirname, "..")))));
}
