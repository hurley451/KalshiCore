#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const validateScript = path.join(repoRoot, "tools", "validate.js");

function copyTree(destination) {
  for (const entry of ["contracts", "fixtures", "sources", "targets"]) {
    fs.cpSync(path.join(repoRoot, entry), path.join(destination, entry), { recursive: true });
  }
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function writeJson(root, relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function runValidate(root) {
  return spawnSync(process.execPath, [validateScript], {
    cwd: repoRoot,
    env: { ...process.env, KALSHICORE_ROOT: root },
    encoding: "utf8"
  });
}

function withFixture(mutator) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kalshicore-validate-"));
  try {
    copyTree(root);
    mutator(root);
    return runValidate(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertPass(name, result) {
  if (result.status !== 0) {
    console.error(`${name}: expected pass`);
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(1);
  }
}

function assertFail(name, result, expectedText) {
  if (result.status === 0) {
    console.error(`${name}: expected failure`);
    console.error(result.stdout);
    process.exit(1);
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(expectedText)) {
    console.error(`${name}: failure did not include ${expectedText}`);
    console.error(output);
    process.exit(1);
  }
}

assertPass("current repository", runValidate(repoRoot));

assertFail(
  "missing required endpoint name",
  withFixture((root) => {
    const file = "contracts/endpoints/portfolio.fills.list.json";
    const contract = readJson(root, file);
    delete contract.name;
    writeJson(root, file, contract);
  }),
  "must have required property 'name'"
);

assertFail(
  "unexpected endpoint property",
  withFixture((root) => {
    const file = "contracts/endpoints/portfolio.fills.list.json";
    const contract = readJson(root, file);
    contract.unexpected = true;
    writeJson(root, file, contract);
  }),
  "must NOT have additional properties"
);

assertFail(
  "missing source kind",
  withFixture((root) => {
    const file = "contracts/endpoints/portfolio.fills.list.json";
    const contract = readJson(root, file);
    delete contract.source.kind;
    writeJson(root, file, contract);
  }),
  "must have required property 'kind'"
);

assertFail(
  "missing fixture path",
  withFixture((root) => {
    const file = "contracts/endpoints/portfolio.fills.list.json";
    const contract = readJson(root, file);
    contract.fixtures.push("../../fixtures/rest/request-serialization/missing.json");
    writeJson(root, file, contract);
  }),
  "resolves to missing"
);

assertFail(
  "unknown target contract",
  withFixture((root) => {
    const file = "targets/csharp/KalshiSharp.json";
    const target = readJson(root, file);
    target.conformance.contractIds.push("unknown.contract");
    writeJson(root, file, target);
  }),
  "unknown contract id unknown.contract"
);

assertFail(
  "unknown official source id",
  withFixture((root) => {
    const file = "contracts/endpoints/portfolio.fills.list.json";
    const contract = readJson(root, file);
    contract.source.sourceId = "missing-source";
    writeJson(root, file, contract);
  }),
  "source.sourceId missing-source is not in official source index"
);

assertFail(
  "unknown official operation id",
  withFixture((root) => {
    const file = "contracts/endpoints/portfolio.fills.list.json";
    const contract = readJson(root, file);
    contract.source.operationId = "MissingOperation";
    writeJson(root, file, contract);
  }),
  "source.operationId MissingOperation is not in official OpenAPI operations"
);

assertFail(
  "reviewed coverage unknown contract",
  withFixture((root) => {
    const file = "contracts/official-coverage.json";
    const coverage = readJson(root, file);
    const operation = coverage.operations.find((entry) => entry.operationId === "GetFills");
    operation.contractId = "missing.contract";
    writeJson(root, file, coverage);
  }),
  "references unknown contract missing.contract"
);

assertFail(
  "missing official coverage operation",
  withFixture((root) => {
    const file = "contracts/official-coverage.json";
    const coverage = readJson(root, file);
    coverage.operations = coverage.operations.filter((entry) => entry.operationId !== "GetFills");
    coverage.operationCount = coverage.operations.length;
    writeJson(root, file, coverage);
  }),
  "missing coverage entry for official operation GetFills"
);

assertFail(
  "active target mutable ref",
  withFixture((root) => {
    const file = "targets/csharp/KalshiSharp.json";
    const target = readJson(root, file);
    target.conformance.status = "active";
    target.conformance.kalshiCoreRef = "main";
    writeJson(root, file, target);
  }),
  "active targets must pin an immutable KalshiCore ref"
);

function mutateJson(file, mutator) {
  return (root) => {
    const document = readJson(root, file);
    mutator(document);
    writeJson(root, file, document);
  };
}

const endpointFile = "contracts/endpoints/portfolio.fills.list.json";
const sourceFile = "sources/official/rest-openapi-operations.json";
const sourceIndexFile = "sources/official/kalshi-official-sources.json";
const coverageFile = "contracts/official-coverage.json";
const targetFile = "targets/csharp/KalshiSharp.json";
const responseFile = "fixtures/rest/response-shape/portfolio-fills-page.json";
const fixtureFiles = [
  "fixtures/auth/signing/rest-get-portfolio-fills.json",
  "fixtures/rest/request-serialization/portfolio-fills-query.json",
  responseFile,
  "fixtures/websocket/replay/orderbook-delta.json"
];

for (const file of fixtureFiles) {
  for (const field of ["input", "expected"]) {
    assertFail(`${file} empty ${field}`, withFixture(mutateJson(file, (fixture) => {
      fixture[field] = {};
    })), field === "expected" && [responseFile, fixtureFiles[3]].includes(file)
      ? "must NOT have fewer than 1 properties" : "must have required property");
  }
}

const negativeCases = [
  ["invalid signing timestamp", fixtureFiles[0], (doc) => { doc.input.timestampMs = "not-a-time"; }, "must match pattern"],
  ["invalid signing header", fixtureFiles[0], (doc) => { doc.expected.headers["KALSHI-ACCESS-SIGNATURE"] = 17; }, "must be string"],
  ["invalid request method", fixtureFiles[1], (doc) => { doc.input.method = "BOGUS"; }, "must be equal to one of the allowed values"],
  ["invalid serialized URL", fixtureFiles[1], (doc) => { doc.expected.pathAndQuery = 17; }, "must be string"],
  ["invalid response status", responseFile, (doc) => { doc.input.status = "200"; }, "must be integer"],
  ["invalid response expectation count", responseFile, (doc) => { doc.expected.fillsCount = "one"; }, "must be integer"],
  ["invalid parsed response expectation", responseFile, (doc) => { doc.expected.firstFill = []; }, "must be object"],
  ["invalid websocket message", fixtureFiles[3], (doc) => { doc.input.messages[0] = {}; }, "must have required property 'type'"],
  ["invalid websocket expectation", fixtureFiles[3], (doc) => { doc.expected.dispatchedTypes = "subscribed"; }, "must be array"],
  ["empty response body", responseFile, (doc) => { doc.input.body = {}; }, "response body"],
  ["wrong response field type", responseFile, (doc) => { doc.input.body.fills = "not-an-array"; }, "response body/fills: must be array"],
  ["unknown response status", responseFile, (doc) => { doc.input.status = 201; }, "no response schema for status 201"],
  ["malformed embedded schema", endpointFile, (doc) => { doc.responses[0].bodySchema = { type: "bogus" }; }, "bodySchema is invalid"],
  ["unresolved embedded schema", endpointFile, (doc) => { doc.responses[0].bodySchema = { $ref: "#/missing" }; }, "bodySchema is invalid"],
  ["unknown schema keyword", endpointFile, (doc) => { doc.responses[0].bodySchema = { type: "object", requred: ["fills"] }; }, "bodySchema is invalid"],
  ["duplicate response status", endpointFile, (doc) => { doc.responses.push(doc.responses[0]); }, "duplicate response status"],
  ["unlinked response fixture", endpointFile, (doc) => { doc.fixtures = doc.fixtures.filter((ref) => !ref.includes("response-shape")); }, "response fixture must be linked"],
  ["endpoint method mismatch", endpointFile, (doc) => { doc.method = "POST"; }, "method/path must match official operation"],
  ["endpoint path mismatch", endpointFile, (doc) => { doc.path = "/trade-api/v2/portfolio/orders"; }, "method/path must match official operation"],
  ["endpoint source mismatch", endpointFile, (doc) => { doc.source.sourceId = "kalshi-llms"; }, "operation sourceId must match OpenAPI inventory"],
  ["duplicate inventory entry", "contracts/inventory.json", (doc) => { doc.contracts.push(doc.contracts[0]); }, "duplicate inventory contract id"],
  ["duplicate official operation", sourceFile, (doc) => { doc.operations[1] = doc.operations[0]; }, "duplicate official operation id"],
  ["duplicate official route", sourceFile, (doc) => { doc.operations[1].method = doc.operations[0].method; doc.operations[1].path = doc.operations[0].path; }, "duplicate official method/path id"],
  ["wrong operation count", sourceFile, (doc) => { doc.operationCount++; }, "operationCount must match"],
  ["source hash mismatch", sourceFile, (doc) => { doc.sha256 = "0".repeat(64); }, "sha256 must match official source index"],
  ["source URL mismatch", sourceFile, (doc) => { doc.url = "https://example.com/openapi.yaml"; }, "url must match official source index"],
  ["source version mismatch", sourceFile, (doc) => { doc.version = "0.0.0"; }, "version must match official source index"],
  ["source index count mismatch", sourceIndexFile, (doc) => { doc.sources.find((s) => s.kind === "openapi").operationCount++; }, "operationCount must match official source index"],
  ["docs hash mismatch", "sources/official/docs-links.json", (doc) => { doc.sha256 = "0".repeat(64); }, "sha256 must match official source index"],
  ["docs count mismatch", "sources/official/docs-links.json", (doc) => { doc.linkCount++; }, "linkCount must match"],
  ["duplicate source id", sourceIndexFile, (doc) => { doc.sources[1].id = doc.sources[0].id; }, "duplicate source id"],
  ["missing source count", sourceIndexFile, (doc) => { delete doc.sources[0].operationCount; }, "must have required property 'operationCount'"],
  ["coverage method mismatch", coverageFile, (doc) => { doc.operations[0].method = "GET"; }, "method/path must match official operation"],
  ["coverage path mismatch", coverageFile, (doc) => { doc.operations[0].path = "/wrong"; }, "method/path must match official operation"],
  ["coverage source mismatch", coverageFile, (doc) => { doc.sourceId = "kalshi-llms"; }, "sourceId must match OpenAPI inventory"],
  ["duplicate coverage entry", coverageFile, (doc) => { doc.operations.push(doc.operations[0]); doc.operationCount++; }, "duplicate coverage operation"],
  ["coverage draft promotion", endpointFile, (doc) => { doc.status = "draft"; }, "requires a ready contract with reviewed provenance"],
  ["coverage pending promotion", endpointFile, (doc) => { doc.source.provenance = "pending-review"; }, "requires a ready contract with reviewed provenance"],
  ["non-reviewed invalid contract link", coverageFile, (doc) => { const op = doc.operations.find((entry) => entry.operationId === "GetFills"); op.status = "future"; op.contractId = "missing.contract"; }, "references unknown contract missing.contract"],
  ["duplicate target contract selection", targetFile, (doc) => { doc.conformance.contractIds.push(doc.conformance.contractIds[0]); }, "must NOT have duplicate items"],
  ["duplicate target fixture selection", targetFile, (doc) => { doc.conformance.fixtureIds.push(doc.conformance.fixtureIds[0]); }, "must NOT have duplicate items"],
  ["duplicate repeated query parameter", sourceFile, (doc) => { doc.operations[0].repeatedQueryParameters = ["ids", "ids"]; }, "must NOT have duplicate items"],
  ["schema substitution", fixtureFiles[0], (doc) => { doc.$schema = "../../../sources/schemas/official-source-index.schema.json"; }, "must reference schema fixtures/schemas/fixture.schema.json"]
];

for (const [name, file, mutate, diagnostic] of negativeCases) {
  assertFail(name, withFixture(mutateJson(file, mutate)), diagnostic);
}

for (const file of ["contracts/inventory.json", coverageFile, sourceIndexFile, sourceFile, "sources/official/docs-links.json"]) {
  assertFail(`missing ${file}`, withFixture((root) => {
    fs.unlinkSync(path.join(root, file));
  }), "required ledger file is missing");
}

for (const ref of ["develop", "release/latest", "refs/heads/main", "HEAD", "deadbee", "0.1.0", "v01.2.3", "v1.2.3-extra"]) {
  assertFail(`active mutable or unsupported ref ${ref}`, withFixture(mutateJson(targetFile, (doc) => {
    doc.conformance.status = "active";
    doc.conformance.kalshiCoreRef = ref;
  })), "active targets must pin an immutable KalshiCore ref");
}

for (const ref of ["v0.1.0", "a".repeat(40)]) {
  assertPass(`supported active ref ${ref}`, withFixture(mutateJson(targetFile, (doc) => {
    doc.conformance.status = "active";
    doc.conformance.kalshiCoreRef = ref;
  })));
}

for (const field of ["contractIds", "fixtureIds"]) {
  assertFail(`empty active ${field}`, withFixture(mutateJson(targetFile, (doc) => {
    doc.conformance.status = "active";
    doc.conformance.kalshiCoreRef = "v0.1.0";
    doc.conformance[field] = [];
  })), "must NOT have fewer than 1 items");
}

assertFail("unlisted endpoint", withFixture((root) => {
  const endpoint = readJson(root, endpointFile);
  endpoint.id = "unlisted.endpoint";
  writeJson(root, "contracts/endpoints/unlisted.json", endpoint);
}), "endpoint is not listed");

for (const [kind, file, destination] of [
  ["fixture", fixtureFiles[0], "fixtures/auth/signing/duplicate.json"],
  ["target", targetFile, "targets/csharp/duplicate.json"]
]) {
  assertFail(`duplicate ${kind}`, withFixture((root) => {
    writeJson(root, destination, readJson(root, file));
  }), `duplicate ${kind} id`);
}

assertPass("optional repeated-query metadata", withFixture(mutateJson(sourceFile, (doc) => {
  doc.operations[0].repeatedQueryParameters = ["ids"];
})));

assertPass("generic response expectations", withFixture(mutateJson(responseFile, (doc) => {
  doc.expected = { parsedBody: doc.input.body };
})));

assertPass("reviewed live-observation provenance", withFixture(mutateJson(endpointFile, (doc) => {
  doc.source.provenance = "observed-live-api";
})));

for (const status of ["future", "irrelevant"]) {
  assertPass(`manual coverage disposition ${status}`, withFixture(mutateJson(coverageFile, (doc) => {
    doc.operations.find((entry) => entry.operationId === "GetFills").status = status;
  })));
}

assertFail("duplicate contract ID", withFixture((root) => {
  writeJson(root, "contracts/endpoints/duplicate.json", readJson(root, endpointFile));
  const inventory = readJson(root, "contracts/inventory.json");
  inventory.contracts.push({ id: "portfolio.fills.list", path: "endpoints/duplicate.json" });
  writeJson(root, "contracts/inventory.json", inventory);
}), "duplicate contract id");

assertFail("duplicate endpoint source operation", withFixture((root) => {
  const endpoint = readJson(root, endpointFile);
  endpoint.id = "duplicate.operation";
  writeJson(root, "contracts/endpoints/duplicate.json", endpoint);
  const inventory = readJson(root, "contracts/inventory.json");
  inventory.contracts.push({ id: endpoint.id, path: "endpoints/duplicate.json" });
  writeJson(root, "contracts/inventory.json", inventory);
}), "duplicate contract operation id");

assertFail("missing source kind", withFixture(mutateJson(sourceIndexFile, (doc) => {
  const source = doc.sources.find((entry) => entry.kind === "asyncapi");
  source.kind = "llms";
  source.linkCount = 1;
})), "missing required asyncapi source");

assertFail("non-object document", withFixture((root) => {
  writeJson(root, responseFile, null);
}), "document must be an object");

console.log("Validator tests passed.");
