#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const root = path.resolve(process.env.KALSHICORE_ROOT || path.resolve(__dirname, ".."));
const jsonRoots = ["contracts", "fixtures", "targets"];
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

function validateEndpointContracts(parsed) {
  for (const [relativePath, contract] of parsed) {
    if (!relativePath.startsWith("contracts/endpoints/")) {
      continue;
    }

    for (const fixtureReference of contract.fixtures || []) {
      const fixturePath = resolveReference(relativePath, fixtureReference);
      expect(parsed.has(fixturePath), `${relativePath}: fixture reference ${fixtureReference} resolves to missing ${fixturePath}`);
    }
  }
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

function main() {
  const parsed = loadDocuments();
  validateSchemas(parsed);

  const contractIds = new Map();
  const fixtureIds = new Map();

  validateInventory(parsed, contractIds);
  validateEndpointContracts(parsed);
  validateFixtures(parsed, fixtureIds);
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
