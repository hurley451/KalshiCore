#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const root = path.resolve(process.env.KALSHICORE_ROOT || path.resolve(__dirname, ".."));
const jsonRoots = ["contracts", "fixtures", "sources", "targets"];
const errors = [];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function resolveReference(fromRelativePath, reference) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRelativePath), reference));
}

function readJson(relativePath) {
  const absolutePath = path.join(root, relativePath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
    return null;
  }
}

function walkJsonFiles(relativeDir) {
  const absoluteDir = path.join(root, relativeDir);
  if (!fs.existsSync(absoluteDir)) {
    return [];
  }

  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relativePath = toPosix(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      return walkJsonFiles(relativePath);
    }
    return entry.isFile() && entry.name.endsWith(".json") ? [relativePath] : [];
  });
}

function expect(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function hasString(value) {
  return typeof value === "string" && value.length > 0;
}

function assertUniqueId(index, id, relativePath, kind) {
  if (!hasString(id)) {
    errors.push(`${relativePath}: missing ${kind} id`);
    return;
  }
  if (index.has(id)) {
    errors.push(`${relativePath}: duplicate ${kind} id "${id}" also used by ${index.get(id)}`);
    return;
  }
  index.set(id, relativePath);
}

function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

function formatAjvErrors(relativePath, validationErrors) {
  return (validationErrors || []).map((error) => {
    const location = error.instancePath || "/";
    return `${relativePath}${location}: ${error.message}`;
  });
}

function loadDocuments() {
  const parsed = new Map();
  for (const relativePath of jsonRoots.flatMap(walkJsonFiles).sort()) {
    const document = readJson(relativePath);
    if (document) {
      parsed.set(relativePath, document);
    }
  }
  return parsed;
}

function validateSchemas(parsed) {
  const ajv = createAjv();

  for (const [relativePath, document] of parsed) {
    if (relativePath.includes("/schemas/")) {
      try {
        ajv.addSchema(document, relativePath);
      } catch (error) {
        errors.push(`${relativePath}: schema could not be registered: ${error.message}`);
      }
    }
  }

  for (const [relativePath, document] of parsed) {
    if (relativePath.includes("/schemas/")) {
      continue;
    }

    if (!hasString(document.$schema)) {
      errors.push(`${relativePath}: $schema must be a non-empty string`);
      continue;
    }

    const schemaPath = resolveReference(relativePath, document.$schema);
    const validate = ajv.getSchema(schemaPath);
    if (!validate) {
      errors.push(`${relativePath}: referenced schema ${schemaPath} is not registered`);
      continue;
    }

    if (!validate(document)) {
      errors.push(...formatAjvErrors(relativePath, validate.errors));
    }
  }
}

function validateInventory(parsed, contractIds) {
  const inventory = parsed.get("contracts/inventory.json");
  expect(Boolean(inventory), "contracts/inventory.json: required inventory file is missing");

  if (!inventory) {
    return;
  }

  for (const entry of inventory.contracts || []) {
    const contractPath = entry.path ? path.posix.join("contracts", entry.path) : "";
    const contract = parsed.get(contractPath);
    expect(Boolean(contract), `contracts/inventory.json: contract ${entry.id || "<unknown>"} points to missing ${contractPath}`);

    if (contract) {
      assertUniqueId(contractIds, contract.id, contractPath, "contract");
      expect(contract.id === entry.id, `${contractPath}: id must match inventory id ${entry.id}`);
    }
  }
}

function collectContractOperationIds(parsed) {
  const ids = new Map();
  for (const [relativePath, contract] of parsed) {
    if (!relativePath.startsWith("contracts/endpoints/")) {
      continue;
    }

    if (hasString(contract.source?.operationId)) {
      ids.set(contract.source.operationId, contract.id);
    }
  }
  return ids;
}

function validateEndpointContracts(parsed) {
  const sourceIds = collectOfficialSourceIds(parsed);
  const operationIds = collectOpenApiOperationIds(parsed);

  for (const [relativePath, contract] of parsed) {
    if (!relativePath.startsWith("contracts/endpoints/")) {
      continue;
    }

    for (const fixtureReference of contract.fixtures || []) {
      const fixturePath = resolveReference(relativePath, fixtureReference);
      expect(parsed.has(fixturePath), `${relativePath}: fixture reference ${fixtureReference} resolves to missing ${fixturePath}`);
    }

    if (contract.source?.sourceId) {
      expect(sourceIds.has(contract.source.sourceId), `${relativePath}: source.sourceId ${contract.source.sourceId} is not in official source index`);
    }
    if (contract.source?.operationId) {
      expect(operationIds.has(contract.source.operationId), `${relativePath}: source.operationId ${contract.source.operationId} is not in official OpenAPI operations`);
    }
  }
}

function collectOfficialSourceIds(parsed) {
  const ids = new Set();
  for (const [relativePath, document] of parsed) {
    if (!relativePath.startsWith("sources/official/") || document.id !== "kalshi-official-sources") {
      continue;
    }

    for (const source of document.sources || []) {
      if (hasString(source.id)) {
        ids.add(source.id);
      }
    }
  }
  return ids;
}

function collectOpenApiOperationIds(parsed) {
  const ids = new Set();
  for (const [relativePath, document] of parsed) {
    if (!relativePath.startsWith("sources/official/") || !Array.isArray(document.operations)) {
      continue;
    }

    expect(
      document.operationCount === document.operations.length,
      `${relativePath}: operationCount must match operations length`
    );

    for (const operation of document.operations) {
      if (hasString(operation.operationId)) {
        ids.add(operation.operationId);
      }
    }
  }
  return ids;
}

function validateFixtures(parsed, fixtureIds) {
  for (const [relativePath, fixture] of parsed) {
    if (!relativePath.startsWith("fixtures/") || relativePath.startsWith("fixtures/schemas/")) {
      continue;
    }

    assertUniqueId(fixtureIds, fixture.id, relativePath, "fixture");
  }
}

function validateTargets(parsed, contractIds, fixtureIds) {
  for (const [relativePath, target] of parsed) {
    if (!relativePath.startsWith("targets/") || relativePath.startsWith("targets/schemas/")) {
      continue;
    }

    for (const contractId of target.conformance?.contractIds || []) {
      expect(contractIds.has(contractId), `${relativePath}: unknown contract id ${contractId}`);
    }
    for (const fixtureId of target.conformance?.fixtureIds || []) {
      expect(fixtureIds.has(fixtureId), `${relativePath}: unknown fixture id ${fixtureId}`);
    }

    if (target.conformance?.status === "active") {
      expect(target.conformance.kalshiCoreRef !== "main", `${relativePath}: active targets must pin an immutable KalshiCore ref, tag, or suite version`);
    }

    expect(hasString(target.adapter?.offlineCommand), `${relativePath}: adapter.offlineCommand must be a non-empty string`);
    expect(hasString(target.adapter?.reportPath), `${relativePath}: adapter.reportPath must be a non-empty string`);
  }
}

function validateSources(parsed) {
  const sourceIds = collectOfficialSourceIds(parsed);

  for (const [relativePath, document] of parsed) {
    if (!relativePath.startsWith("sources/official/")) {
      continue;
    }

    if (document.sourceId) {
      expect(sourceIds.has(document.sourceId), `${relativePath}: sourceId ${document.sourceId} is not in official source index`);
    }
    if (Array.isArray(document.links)) {
      expect(document.linkCount === document.links.length, `${relativePath}: linkCount must match links length`);
    }
  }
}

function validateOfficialCoverage(parsed, contractIds) {
  const sourceIds = collectOfficialSourceIds(parsed);
  const operationIds = collectOpenApiOperationIds(parsed);
  const contractOperationIds = collectContractOperationIds(parsed);

  for (const [relativePath, coverage] of parsed) {
    if (relativePath !== "contracts/official-coverage.json") {
      continue;
    }

    expect(sourceIds.has(coverage.sourceId), `${relativePath}: sourceId ${coverage.sourceId} is not in official source index`);
    expect(coverage.operationCount === coverage.operations?.length, `${relativePath}: operationCount must match operations length`);

    const coveredOperationIds = new Set();
    for (const operation of coverage.operations || []) {
      expect(operationIds.has(operation.operationId), `${relativePath}: operationId ${operation.operationId} is not in official OpenAPI operations`);
      coveredOperationIds.add(operation.operationId);

      if (operation.status === "reviewed") {
        expect(hasString(operation.contractId), `${relativePath}: reviewed operation ${operation.operationId} must include contractId`);
        expect(contractIds.has(operation.contractId), `${relativePath}: reviewed operation ${operation.operationId} references unknown contract ${operation.contractId}`);
        expect(
          contractOperationIds.get(operation.operationId) === operation.contractId,
          `${relativePath}: reviewed operation ${operation.operationId} must match endpoint contract source.operationId`
        );
      }
    }

    for (const operationId of operationIds) {
      expect(coveredOperationIds.has(operationId), `${relativePath}: missing coverage entry for official operation ${operationId}`);
    }
  }
}

function main() {
  const parsed = loadDocuments();
  validateSchemas(parsed);

  const contractIds = new Map();
  const fixtureIds = new Map();

  validateInventory(parsed, contractIds);
  validateEndpointContracts(parsed);
  validateFixtures(parsed, fixtureIds);
  validateSources(parsed);
  validateOfficialCoverage(parsed, contractIds);
  validateTargets(parsed, contractIds, fixtureIds);

  if (errors.length > 0) {
    console.error(`Validation failed with ${errors.length} issue(s):`);
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Validated ${parsed.size} JSON file(s), ${contractIds.size} contract(s), and ${fixtureIds.size} fixture(s).`);
}

main();
