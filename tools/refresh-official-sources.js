#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const YAML = require("yaml");

const root = path.resolve(process.env.KALSHICORE_ROOT || path.resolve(__dirname, ".."));
const generatedAt = new Date().toISOString();

const sources = [
  {
    id: "kalshi-openapi-rest",
    kind: "openapi",
    url: "https://docs.kalshi.com/openapi.yaml"
  },
  {
    id: "kalshi-asyncapi-websocket",
    kind: "asyncapi",
    url: "https://docs.kalshi.com/asyncapi.yaml"
  },
  {
    id: "kalshi-llms",
    kind: "llms",
    url: "https://docs.kalshi.com/llms.txt"
  }
];

const methodNames = new Set(["get", "post", "put", "patch", "delete"]);

async function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fetchText(new URL(response.headers.location, url).toString()).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`${url}: HTTP ${response.statusCode}`));
        response.resume();
        return;
      }

      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

function digest(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function lineCount(text) {
  return text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
}

function byteCount(text) {
  return Buffer.byteLength(text, "utf8");
}

function parseYaml(text, url) {
  try {
    return YAML.parse(text);
  } catch (error) {
    throw new Error(`${url}: ${error.message}`);
  }
}

function extractOpenApiOperations(document) {
  const operations = [];
  for (const [route, pathItem] of Object.entries(document.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!methodNames.has(method) || typeof operation !== "object" || operation === null) {
        continue;
      }

      operations.push({
        path: route,
        method: method.toUpperCase(),
        operationId: operation.operationId,
        ...(operation.summary ? { summary: operation.summary } : {}),
        ...(Array.isArray(operation.tags) ? { tags: operation.tags } : {})
      });
    }
  }

  operations.sort((left, right) => `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`));
  return operations;
}

function extractDocsLinks(text) {
  const links = [];
  const expression = /^- \[([^\]]+)]\((https:\/\/docs\.kalshi\.com\/[^)]+)\)(?::\s*(.*))?$/gm;
  let match;
  while ((match = expression.exec(text)) !== null) {
    links.push({
      title: match[1],
      url: match[2],
      ...(match[3] ? { description: match[3] } : {})
    });
  }
  return links;
}

function writeJson(relativePath, value) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readReviewedContracts() {
  const endpointDir = path.join(root, "contracts", "endpoints");
  if (!fs.existsSync(endpointDir)) {
    return new Map();
  }

  const reviewed = new Map();
  for (const fileName of fs.readdirSync(endpointDir).filter((entry) => entry.endsWith(".json")).sort()) {
    const contract = JSON.parse(fs.readFileSync(path.join(endpointDir, fileName), "utf8"));
    const operationId = contract.source?.operationId;
    if (operationId) {
      reviewed.set(operationId, contract.id);
    }
  }
  return reviewed;
}

function writeCoverage(sourceId, operations) {
  const reviewedContracts = readReviewedContracts();
  const coverage = operations.map((operation) => {
    const contractId = reviewedContracts.get(operation.operationId);
    return {
      operationId: operation.operationId,
      path: operation.path,
      method: operation.method,
      status: contractId ? "reviewed" : "unreviewed",
      ...(contractId ? { contractId } : {})
    };
  });

  writeJson("contracts/official-coverage.json", {
    $schema: "./schemas/official-coverage.schema.json",
    sourceId,
    generatedAt,
    operationCount: coverage.length,
    operations: coverage
  });
}

async function main() {
  const indexEntries = [];

  for (const source of sources) {
    const text = await fetchText(source.url);
    const metadata = {
      id: source.id,
      kind: source.kind,
      url: source.url,
      sha256: digest(text),
      byteCount: byteCount(text),
      lineCount: lineCount(text)
    };

    if (source.kind === "openapi") {
      const document = parseYaml(text, source.url);
      const operations = extractOpenApiOperations(document);
      metadata.version = String(document.info?.version || "");
      metadata.operationCount = operations.length;
      writeCoverage(source.id, operations);
      writeJson("sources/official/rest-openapi-operations.json", {
        $schema: "../schemas/openapi-operations.schema.json",
        sourceId: source.id,
        url: source.url,
        version: metadata.version,
        sha256: metadata.sha256,
        operationCount: operations.length,
        operations
      });
    }

    if (source.kind === "asyncapi") {
      const document = parseYaml(text, source.url);
      metadata.version = String(document.info?.version || "");
      metadata.channelCount = Object.keys(document.channels || {}).length;
    }

    if (source.kind === "llms") {
      const links = extractDocsLinks(text);
      metadata.linkCount = links.length;
      writeJson("sources/official/docs-links.json", {
        $schema: "../schemas/docs-links.schema.json",
        sourceId: source.id,
        url: source.url,
        sha256: metadata.sha256,
        linkCount: links.length,
        links
      });
    }

    indexEntries.push(metadata);
  }

  writeJson("sources/official/kalshi-official-sources.json", {
    $schema: "../schemas/official-source-index.schema.json",
    id: "kalshi-official-sources",
    generatedAt,
    sources: indexEntries
  });

  for (const source of indexEntries) {
    const detail = source.operationCount ?? source.channelCount ?? source.linkCount;
    console.log(`${source.id}: ${source.sha256}${detail === undefined ? "" : ` (${detail})`}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
