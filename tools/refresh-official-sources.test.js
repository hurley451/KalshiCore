#!/usr/bin/env node

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const fs = require("fs");
const os = require("os");
const path = require("path");
const YAML = require("yaml");
const { extractOpenApiOperations, buildCoverage, refreshSources, fetchText } = require("./refresh-official-sources");

const repo = path.resolve(__dirname, "..");
const outputs = ["contracts/official-coverage.json", "sources/official/rest-openapi-operations.json",
  "sources/official/docs-links.json", "sources/official/kalshi-official-sources.json"];
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const write = (root, file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kalshi-refresh-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ["contracts", "fixtures", "sources", "targets"]) {
    fs.cpSync(path.join(repo, directory), path.join(root, directory), { recursive: true });
  }
  return root;
}

function bodies(root) {
  const inventory = read(root, outputs[1]);
  const paths = {};
  for (const operation of inventory.operations) {
    paths[operation.path] ||= {};
    paths[operation.path][operation.method.toLowerCase()] = {
      operationId: operation.operationId,
      ...(operation.repeatedQueryParameters ? { parameters: operation.repeatedQueryParameters.map((name) =>
        ({ in: "query", name, schema: { type: "array", items: { type: "string" } } })) } : {})
    };
  }
  return {
    "https://docs.kalshi.com/openapi.yaml": YAML.stringify({ openapi: "3.0.0", info: { version: "test" }, paths }),
    "https://docs.kalshi.com/asyncapi.yaml": "asyncapi: 2.6.0\ninfo:\n  version: test\nchannels: {}\n",
    "https://docs.kalshi.com/llms.txt": "- [Fills](https://docs.kalshi.com/api-reference/portfolio/get-fills): Fills endpoint\n"
  };
}

function transport(handler) {
  const requests = [];
  const responses = [];
  return {
    requests, responses,
    get(url, callback) {
      const request = new EventEmitter();
      request.destroy = () => { request.destroyed = true; };
      requests.push(request);
      queueMicrotask(() => {
        const result = handler(url, requests.length);
        if (result === null) return;
        if (result instanceof Error) { request.emit("error", result); return; }
        const response = Readable.from([result.body || ""]);
        response.statusCode = result.status || 200;
        response.headers = result.location ? { location: result.location } : {};
        response.complete = true;
        responses.push(response);
        callback(response);
      });
      return request;
    }
  };
}

const successfulTransport = (root) => {
  const texts = bodies(root);
  return transport((url) => ({ body: texts[url] }));
};
const snapshot = (root) => outputs.map((file) => fs.readFileSync(path.join(root, file)));
function unchanged(root, before) {
  outputs.forEach((file, index) => assert.deepEqual(fs.readFileSync(path.join(root, file)), before[index], file));
  assert.equal(fs.readdirSync(root).some((file) => file.startsWith(".source-refresh-")), false);
}

test("parses YAML and extracts repeated query defaults, refs, inheritance and overrides", () => {
  const document = YAML.parse(`openapi: 3.0.0
paths:
  /items:
    $ref: '#/components/pathItems/Items'
components:
  pathItems:
    Items:
      parameters:
        - $ref: '#/components/parameters/Ids'
        - {in: query, name: overridden, schema: {type: array}}
      get:
        operationId: ListItems
        parameters:
          - {in: query, name: overridden, explode: false, schema: {type: array}}
          - {in: query, name: explicit, style: form, explode: true, schema: {type: array}}
          - {in: query, name: pipe, style: pipeDelimited, schema: {type: array}}
          - {in: header, name: header, schema: {type: array}}
          - {in: query, name: scalar, schema: {type: string}}
      post:
        operationId: CreateItems
        parameters:
          - {in: query, name: ids, explode: false, schema: {type: array}}
          - {in: query, name: overridden, schema: {type: string}}
  parameters:
    Ids:
      in: query
      name: ids
      schema: {$ref: '#/components/schemas/Ids'}
  schemas:
    Ids: {type: array, items: {type: string}}
`);
  const operations = extractOpenApiOperations(document);
  assert.deepEqual(operations[0].repeatedQueryParameters, ["explicit", "ids"]);
  assert.equal(Object.hasOwn(operations[1], "repeatedQueryParameters"), false);
  document.components.parameters.Ids.$ref = "#/components/parameters/Ids";
  assert.throws(() => extractOpenApiOperations(document), /Unresolvable reference/);
});

test("missing and duplicate OpenAPI operation IDs fail", () => {
  assert.throws(() => extractOpenApiOperations({ openapi: "3", paths: { "/x": { get: {} } } }), /missing operationId/);
  assert.throws(() => extractOpenApiOperations({ openapi: "3", paths: {
    "/x": { get: { operationId: "Same" }, post: { operationId: "Same" } }
  } }), /Duplicate operationId/);
});

test("refresh stages and validates actual parsed outputs", async (t) => {
  const root = fixture(t);
  const output = await refreshSources(root, { transport: successfulTransport(root) });
  assert.equal(output.size, 4);
  const index = read(root, outputs[3]);
  assert.equal(index.sources[0].operationCount, read(root, outputs[1]).operations.length);
  assert.equal(index.sources[0].sha256, read(root, outputs[1]).sha256);
  assert.equal(read(root, outputs[2]).links[0].description, "Fills endpoint");
  assert.equal(read(root, outputs[0]).operations.find((value) => value.operationId === "GetFills").status, "reviewed");
  for (const operation of read(repo, outputs[1]).operations.filter((value) => value.repeatedQueryParameters)) {
    assert.deepEqual(read(root, outputs[1]).operations.find((value) => value.operationId === operation.operationId)
      .repeatedQueryParameters, operation.repeatedQueryParameters);
  }
});

test("draft and pending provenance never become reviewed", (t) => {
  const root = fixture(t);
  const contractFile = "contracts/endpoints/portfolio.fills.list.json";
  const contract = read(root, contractFile);
  const coverage = read(root, outputs[0]);
  const entry = coverage.operations.find((value) => value.operationId === "GetFills");
  entry.status = "unreviewed";
  delete entry.contractId;
  entry.notes = "Needs review";
  write(root, outputs[0], coverage);
  for (const [status, provenance] of [["draft", "official-confirmed"], ["ready", "pending-review"],
    ["ready", "observed-sdk"], ["ready", "fixture-inferred"], ["ready", "observed-live-api"]]) {
    contract.status = status;
    contract.source.provenance = provenance;
    write(root, contractFile, contract);
    const result = buildCoverage(root, coverage.sourceId, coverage.operations, "2026-10-11T00:00:00Z");
    assert.equal(result.operations.find((value) => value.operationId === "GetFills").status, "unreviewed");
    assert.equal(result.operations.find((value) => value.operationId === "GetFills").notes, "Needs review");
  }
});

test("refresh preserves existing ready reviewed live observations and notes", async (t) => {
  const root = fixture(t);
  const file = "contracts/endpoints/portfolio.fills.list.json";
  const contract = read(root, file);
  contract.source.provenance = "observed-live-api";
  write(root, file, contract);
  const coverage = read(root, outputs[0]);
  const previous = coverage.operations.find((value) => value.operationId === "GetFills");
  previous.notes = "Reviewed live response evidence";
  write(root, outputs[0], coverage);
  await refreshSources(root, { transport: successfulTransport(root) });
  assert.deepEqual(read(root, outputs[0]).operations.find((value) => value.operationId === "GetFills"), previous);
});

test("reviewed live observations with mismatched identities fail without changing outputs", async (t) => {
  for (const change of [
    (contract) => { contract.source.sourceId = "wrong-source"; },
    (contract) => { contract.source.operationId = "WrongOperation"; },
    (contract) => { contract.method = "POST"; },
    (contract) => { contract.path = "/trade-api/v2/wrong"; },
    (contract) => { contract.id = "wrong-contract"; },
    (contract) => { contract.status = "draft"; }
  ]) {
    const root = fixture(t);
    const file = "contracts/endpoints/portfolio.fills.list.json";
    const contract = read(root, file);
    contract.source.provenance = "observed-live-api";
    change(contract);
    write(root, file, contract);
    const before = snapshot(root);
    await assert.rejects(refreshSources(root, { transport: successfulTransport(root) }), /Inconsistent reviewed identity/);
    unchanged(root, before);
  }
});

test("preserves future, irrelevant and reviewed notes; rejects changed or removed dispositions", (t) => {
  const root = fixture(t);
  const coverage = read(root, outputs[0]);
  const unreviewed = coverage.operations.filter((value) => value.status === "unreviewed");
  for (const [index, status] of ["future", "irrelevant"].entries()) {
    unreviewed[index].status = status;
    unreviewed[index].notes = `Keep ${status}`;
  }
  const reviewed = coverage.operations.find((value) => value.status === "reviewed");
  reviewed.notes = "Reviewed evidence";
  write(root, outputs[0], coverage);
  const result = buildCoverage(root, coverage.sourceId, coverage.operations, "2026-10-11T00:00:00Z");
  for (const entry of [unreviewed[0], unreviewed[1], reviewed]) {
    assert.deepEqual(result.operations.find((value) => value.operationId === entry.operationId), entry);
  }
  assert.throws(() => buildCoverage(root, coverage.sourceId,
    coverage.operations.filter((value) => value.operationId !== unreviewed[0].operationId)), /erase disposition/);
  assert.throws(() => buildCoverage(root, coverage.sourceId, coverage.operations.map((value) =>
    value.operationId === reviewed.operationId ? { ...value, method: "POST" } : value)), /identity/);
});

test("rejects reviewed provenance downgrade, mismatched contract identity and duplicate IDs", (t) => {
  const root = fixture(t);
  const coverage = read(root, outputs[0]);
  const file = "contracts/endpoints/portfolio.fills.list.json";
  const original = read(root, file);
  for (const change of [
    (contract) => { contract.status = "draft"; },
    (contract) => { contract.source.provenance = "pending-review"; },
    (contract) => { contract.source.sourceId = "wrong"; },
    (contract) => { contract.path = "/trade-api/v2/wrong"; },
    (contract) => { contract.method = "POST"; },
    (contract) => { delete contract.id; }
  ]) {
    const contract = structuredClone(original);
    change(contract);
    write(root, file, contract);
    assert.throws(() => buildCoverage(root, coverage.sourceId, coverage.operations), /identity|missing contract id/);
  }
  write(root, file, original);
  write(root, "contracts/endpoints/duplicate.json", original);
  assert.throws(() => buildCoverage(root, coverage.sourceId, coverage.operations), /Duplicate contract id/);
  write(root, "contracts/endpoints/duplicate.json", { ...original, id: "duplicate" });
  assert.throws(() => buildCoverage(root, coverage.sourceId, coverage.operations), /Duplicate contract operationId/);
  fs.rmSync(path.join(root, "contracts/endpoints/duplicate.json"));
  coverage.operations.push(coverage.operations[0]);
  write(root, outputs[0], coverage);
  assert.throws(() => buildCoverage(root, coverage.sourceId, coverage.operations), /duplicate coverage operationId/);
  coverage.operations.pop();
  delete coverage.operations[0].operationId;
  write(root, outputs[0], coverage);
  assert.throws(() => buildCoverage(root, coverage.sourceId, coverage.operations), /Missing or duplicate coverage operationId/);
});

for (const failure of ["http", "network", "parse", "openapi-shape", "asyncapi-shape", "links", "timeout", "redirect", "missing-id", "duplicate-id"]) {
  test(`${failure} failure preserves every current output`, async (t) => {
    const root = fixture(t);
    const before = snapshot(root);
    const texts = bodies(root);
    const injected = transport((url) => {
      if (failure === "redirect") return { status: 302, location: url };
      if (failure === "timeout") return null;
      if (url.endsWith("asyncapi.yaml")) {
        if (failure === "http") return { status: 503 };
        if (failure === "network") return new Error("network failed");
        if (failure === "parse") return { body: "broken: [" };
        if (failure === "asyncapi-shape") return { body: "<html>Oops</html>" };
      }
      if (url.endsWith("llms.txt") && failure === "links") return { body: "<html>Oops</html>" };
      if (url.endsWith("openapi.yaml")) {
        if (failure === "openapi-shape") return { body: "<html>Oops</html>" };
        if (["missing-id", "duplicate-id"].includes(failure)) {
          const document = YAML.parse(texts[url]);
          const operations = Object.values(document.paths).flatMap((value) => Object.values(value));
          if (failure === "missing-id") delete operations[0].operationId;
          else operations[1].operationId = operations[0].operationId;
          return { body: YAML.stringify(document) };
        }
      }
      return { body: texts[url] };
    });
    await assert.rejects(refreshSources(root, { transport: injected, timeoutMs: 20, maxRedirects: 2 }));
    unchanged(root, before);
    if (failure === "timeout") assert.equal(injected.requests[0].destroyed, true);
    if (failure === "redirect") assert.equal(injected.requests.length, 3);
  });
}

test("bounded relative redirects succeed and reject HTTPS downgrade", async () => {
  const injected = transport((url) => url.endsWith("/start") ? { status: 302, location: "/end" } : { body: "ok" });
  assert.equal(await fetchText("https://docs.kalshi.com/start", { transport: injected }), "ok");
  await assert.rejects(fetchText("https://docs.kalshi.com/start", {
    transport: transport(() => ({ status: 302, location: "http://docs.kalshi.com/end" }))
  }), /HTTPS required/);
});

test("timeout closes a stalled body and ignores late redirect responses", async () => {
  const response = new Readable({ read() {} });
  response.statusCode = 200;
  response.headers = {};
  const request = new EventEmitter();
  request.destroy = () => { request.destroyed = true; };
  await assert.rejects(fetchText("https://docs.kalshi.com/stalled", {
    timeoutMs: 10,
    transport: { get(url, callback) { queueMicrotask(() => callback(response)); return request; } }
  }), /timeout/);
  assert.equal(response.destroyed, true);
  assert.equal(request.destroyed, true);
  let callback;
  let calls = 0;
  await assert.rejects(fetchText("https://docs.kalshi.com/late", {
    timeoutMs: 10,
    transport: { get(url, handler) { calls++; callback = handler; return request; } }
  }), /timeout/);
  const late = Readable.from([]);
  late.statusCode = 302;
  late.headers = { location: "/next" };
  callback(late);
  assert.equal(late.destroyed, true);
  assert.equal(calls, 1);
});

test("reviewed coverage without an eligible contract or contractId cannot be demoted silently", (t) => {
  const root = fixture(t);
  const file = "contracts/endpoints/portfolio.fills.list.json";
  const contract = read(root, file);
  contract.status = "draft";
  write(root, file, contract);
  const coverage = read(root, outputs[0]);
  delete coverage.operations.find((value) => value.status === "reviewed").contractId;
  write(root, outputs[0], coverage);
  assert.throws(() => buildCoverage(root, coverage.sourceId, coverage.operations), /Inconsistent reviewed identity/);
});

test("candidate validation rejects invalid output before replacement", async (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  await assert.rejects(refreshSources(root, { transport: successfulTransport(root), generatedAt: "invalid" }), /Candidate validation failed/);
  unchanged(root, before);
});

test("replacement and post-replacement validation failures roll back", async (t) => {
  for (const mode of ["rename", "validation"]) {
    const root = fixture(t);
    const before = snapshot(root);
    let calls = 0;
    const options = { transport: successfulTransport(root) };
    if (mode === "rename") options.rename = (from, to) => {
      if (++calls === 2) throw new Error("rename failed");
      fs.renameSync(from, to);
    };
    else options.validate = () => { if (++calls === 2) throw new Error("validation failed"); };
    await assert.rejects(refreshSources(root, options), /failed/);
    unchanged(root, before);
  }
});

test("concurrent snapshot edits are preserved and prevent replacement", async (t) => {
  const root = fixture(t);
  const changed = Buffer.from("concurrent worker edit\n");
  await assert.rejects(refreshSources(root, {
    transport: successfulTransport(root),
    validate: () => fs.writeFileSync(path.join(root, outputs[0]), changed)
  }), /Snapshot changed during refresh/);
  assert.deepEqual(fs.readFileSync(path.join(root, outputs[0])), changed);
});
