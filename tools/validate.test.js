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
  copyTree(root);
  mutator(root);
  return runValidate(root);
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

console.log("Validator tests passed.");
