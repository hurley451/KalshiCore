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

function createAjv(options = {}) {
  const ajv = new Ajv2020({ allErrors: true, strict: false, ...options });
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
    if (document && typeof document === "object" && !Array.isArray(document)) {
      parsed.set(relativePath, document);
    } else {
      errors.push(`${relativePath}: document must be an object`);
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
    const expectedSchema = relativePath.startsWith("contracts/endpoints/")
      ? "contracts/schemas/endpoint-contract.schema.json"
      : relativePath.startsWith("fixtures/") ? "fixtures/schemas/fixture.schema.json"
      : relativePath.startsWith("targets/") ? "targets/schemas/sdk-target.schema.json"
      : {
        "contracts/inventory.json": "contracts/schemas/contract-inventory.schema.json",
        "contracts/official-coverage.json": "contracts/schemas/official-coverage.schema.json",
        "sources/official/kalshi-official-sources.json": "sources/schemas/official-source-index.schema.json",
        "sources/official/rest-openapi-operations.json": "sources/schemas/openapi-operations.schema.json",
        "sources/official/docs-links.json": "sources/schemas/docs-links.schema.json"
      }[relativePath];
    expect(!expectedSchema || schemaPath === expectedSchema, `${relativePath}: must reference schema ${expectedSchema}`);
    let validate;
    try {
      validate = ajv.getSchema(expectedSchema || schemaPath);
    } catch (error) {
      errors.push(`${relativePath}: schema could not be compiled: ${error.message}`);
      continue;
    }
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

  const entryIds = new Map();
  const entryPaths = new Map();
  for (const entry of inventory.contracts || []) {
    const contractPath = entry.path ? path.posix.join("contracts", entry.path) : "";
    assertUniqueId(entryIds, entry.id, "contracts/inventory.json", "inventory contract");
    assertUniqueId(entryPaths, contractPath, "contracts/inventory.json", "inventory path");
    expect(contractPath.startsWith("contracts/endpoints/"), `contracts/inventory.json: path must identify an endpoint contract: ${contractPath}`);
    const contract = parsed.get(contractPath);
    expect(Boolean(contract), `contracts/inventory.json: contract ${entry.id || "<unknown>"} points to missing ${contractPath}`);

    if (contract) {
      assertUniqueId(contractIds, contract.id, contractPath, "contract");
      expect(contract.id === entry.id, `${contractPath}: id must match inventory id ${entry.id}`);
    }
  }
  for (const [relativePath, contract] of parsed) {
    if (relativePath.startsWith("contracts/endpoints/")) {
      expect(entryPaths.has(relativePath), `${relativePath}: endpoint is not listed in contracts/inventory.json`);
      if (!entryPaths.has(relativePath)) assertUniqueId(contractIds, contract.id, relativePath, "contract");
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
  const operations = new Map((parsed.get("sources/official/rest-openapi-operations.json")?.operations || []).map((operation) => [operation.operationId, operation]));
  const operationOwners = new Map();
  const linkedResponses = new Set();

  for (const [relativePath, contract] of parsed) {
    if (!relativePath.startsWith("contracts/endpoints/")) {
      continue;
    }

    const responseValidators = new Map();
    for (const response of contract.responses || []) {
      expect(!responseValidators.has(response.status), `${relativePath}: duplicate response status ${response.status}`);
      try {
        // Compile each embedded schema independently to detect invalid keywords and unresolved refs.
        const validate = createAjv({ strictSchema: true }).compile(response.bodySchema);
        responseValidators.set(response.status, validate);
      } catch (error) {
        errors.push(`${relativePath}: response ${response.status} bodySchema is invalid: ${error.message}`);
      }
    }
    for (const fixtureReference of contract.fixtures || []) {
      const fixturePath = resolveReference(relativePath, fixtureReference);
      const fixture = parsed.get(fixturePath);
      expect(Boolean(fixture), `${relativePath}: fixture reference ${fixtureReference} resolves to missing ${fixturePath}`);
      expect(fixturePath.startsWith("fixtures/") && !fixturePath.startsWith("fixtures/schemas/"), `${relativePath}: fixture reference must identify a fixture`);
      if (fixture?.kind === "rest-response-shape") {
        linkedResponses.add(fixturePath);
        const validate = responseValidators.get(fixture.input.status);
        expect(Boolean(validate), `${fixturePath}: no response schema for status ${fixture.input.status} in ${relativePath}`);
        if (validate && !validate(fixture.input.body)) {
          errors.push(...formatAjvErrors(`${fixturePath}: response body`, validate.errors));
        }
      }
    }

    if (contract.source?.sourceId) {
      expect(sourceIds.has(contract.source.sourceId), `${relativePath}: source.sourceId ${contract.source.sourceId} is not in official source index`);
    }
    if (contract.source?.operationId) {
      const operation = operations.get(contract.source.operationId);
      expect(Boolean(operation), `${relativePath}: source.operationId ${contract.source.operationId} is not in official OpenAPI operations`);
      assertUniqueId(operationOwners, contract.source.operationId, relativePath, "contract operation");
      expect(contract.source.sourceId === parsed.get("sources/official/rest-openapi-operations.json")?.sourceId, `${relativePath}: operation sourceId must match OpenAPI inventory`);
      if (operation) {
        expect(contract.method === operation.method && contract.path === `/trade-api/v2${operation.path}`, `${relativePath}: method/path must match official operation ${operation.operationId}`);
      }
    }
  }
  for (const [relativePath, fixture] of parsed) {
    if (fixture.kind === "rest-response-shape") {
      expect(linkedResponses.has(relativePath), `${relativePath}: response fixture must be linked by an endpoint contract`);
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
  const targetIds = new Map();
  for (const [relativePath, target] of parsed) {
    if (!relativePath.startsWith("targets/") || relativePath.startsWith("targets/schemas/")) {
      continue;
    }

    assertUniqueId(targetIds, target.id, relativePath, "target");
    for (const contractId of target.conformance?.contractIds || []) {
      expect(contractIds.has(contractId), `${relativePath}: unknown contract id ${contractId}`);
    }
    for (const fixtureId of target.conformance?.fixtureIds || []) {
      expect(fixtureIds.has(fixtureId), `${relativePath}: unknown fixture id ${fixtureId}`);
    }

    if (target.conformance?.status === "active") {
      expect(/^(?:[a-fA-F0-9]{40}|v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.test(target.conformance.kalshiCoreRef), `${relativePath}: active targets must pin an immutable KalshiCore ref (vMAJOR.MINOR.PATCH tag or full commit SHA)`);
    }

    expect(hasString(target.adapter?.offlineCommand), `${relativePath}: adapter.offlineCommand must be a non-empty string`);
    expect(hasString(target.adapter?.reportPath), `${relativePath}: adapter.reportPath must be a non-empty string`);
  }
}

function validateSources(parsed) {
  const sourceIds = collectOfficialSourceIds(parsed);
  const indexPath = "sources/official/kalshi-official-sources.json";
  const index = parsed.get(indexPath);
  const ids = new Map();
  const kinds = new Map();
  for (const source of index?.sources || []) {
    assertUniqueId(ids, source.id, indexPath, "source");
    assertUniqueId(kinds, source.kind, indexPath, "source kind");
  }
  for (const kind of ["openapi", "asyncapi", "llms"]) {
    expect(kinds.has(kind), `${indexPath}: missing required ${kind} source`);
  }

  for (const [relativePath, document] of parsed) {
    if (!relativePath.startsWith("sources/official/")) {
      continue;
    }

    if (document.sourceId) {
      expect(sourceIds.has(document.sourceId), `${relativePath}: sourceId ${document.sourceId} is not in official source index`);
      const source = index?.sources.find((entry) => entry.id === document.sourceId);
      if (source) {
        for (const key of ["url", "sha256", "version", "operationCount", "linkCount"]) {
          if (Object.hasOwn(document, key)) {
            expect(document[key] === source[key], `${relativePath}: ${key} must match official source index`);
          }
        }
        const expectedKind = Array.isArray(document.operations) ? "openapi" : "llms";
        expect(source.kind === expectedKind, `${relativePath}: source kind must be ${expectedKind}`);
      }
    }
    if (Array.isArray(document.operations)) {
      const operations = new Map();
      const routes = new Map();
      for (const operation of document.operations) {
        assertUniqueId(operations, operation.operationId, relativePath, "official operation");
        assertUniqueId(routes, `${operation.method} ${operation.path}`, relativePath, "official method/path");
      }
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
  const official = parsed.get("sources/official/rest-openapi-operations.json");
  const officialOperations = new Map((official?.operations || []).map((operation) => [operation.operationId, operation]));

  for (const [relativePath, coverage] of parsed) {
    if (relativePath !== "contracts/official-coverage.json") {
      continue;
    }

    expect(sourceIds.has(coverage.sourceId), `${relativePath}: sourceId ${coverage.sourceId} is not in official source index`);
    expect(coverage.sourceId === official?.sourceId, `${relativePath}: sourceId must match OpenAPI inventory`);
    expect(coverage.operationCount === official?.operationCount, `${relativePath}: operationCount must match OpenAPI inventory`);
    expect(coverage.operationCount === coverage.operations?.length, `${relativePath}: operationCount must match operations length`);

    const coveredOperationIds = new Set();
    for (const operation of coverage.operations || []) {
      expect(operationIds.has(operation.operationId), `${relativePath}: operationId ${operation.operationId} is not in official OpenAPI operations`);
      expect(!coveredOperationIds.has(operation.operationId), `${relativePath}: duplicate coverage operation ${operation.operationId}`);
      coveredOperationIds.add(operation.operationId);
      const sourceOperation = officialOperations.get(operation.operationId);
      if (sourceOperation) {
        expect(operation.method === sourceOperation.method && operation.path === sourceOperation.path, `${relativePath}: method/path must match official operation ${operation.operationId}`);
      }

      if (operation.status === "reviewed") {
        expect(hasString(operation.contractId), `${relativePath}: reviewed operation ${operation.operationId} must include contractId`);
        expect(contractIds.has(operation.contractId), `${relativePath}: reviewed operation ${operation.operationId} references unknown contract ${operation.contractId}`);
        expect(
          contractOperationIds.get(operation.operationId) === operation.contractId,
          `${relativePath}: reviewed operation ${operation.operationId} must match endpoint contract source.operationId`
        );
        const contract = parsed.get(contractIds.get(operation.contractId));
        expect(contract?.status === "ready" && ["official-confirmed", "observed-live-api"].includes(contract?.source?.provenance), `${relativePath}: reviewed operation ${operation.operationId} requires a ready contract with reviewed provenance`);
      } else if (operation.contractId) {
        expect(contractIds.has(operation.contractId), `${relativePath}: operation ${operation.operationId} references unknown contract ${operation.contractId}`);
        expect(contractOperationIds.get(operation.operationId) === operation.contractId, `${relativePath}: operation ${operation.operationId} must match endpoint contract source.operationId`);
      }
    }

    for (const operationId of operationIds) {
      expect(coveredOperationIds.has(operationId), `${relativePath}: missing coverage entry for official operation ${operationId}`);
    }
  }
}

function main() {
  const parsed = loadDocuments();
  for (const requiredPath of ["contracts/inventory.json", "contracts/official-coverage.json", "sources/official/kalshi-official-sources.json", "sources/official/rest-openapi-operations.json", "sources/official/docs-links.json"]) {
    expect(parsed.has(requiredPath), `${requiredPath}: required ledger file is missing`);
  }
  validateSchemas(parsed);

  const contractIds = new Map();
  const fixtureIds = new Map();

  // Cross-document checks require valid structural shapes to avoid accidental TypeErrors.
  if (errors.length === 0) {
    validateInventory(parsed, contractIds);
    validateEndpointContracts(parsed);
    validateFixtures(parsed, fixtureIds);
    validateSources(parsed);
    validateOfficialCoverage(parsed, contractIds);
    validateTargets(parsed, contractIds, fixtureIds);
  }

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
