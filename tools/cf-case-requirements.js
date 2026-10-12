const assert = require("node:assert/strict");

const sourceId = "cfbenchmarks-rest-manual";
const ids = ["cfbenchmarks.values", "cfbenchmarks.history-values", "cfbenchmarks.passthrough"];
const paths = ["values", "history/values", "arbitrary/next"];
const prefix = "/trade-api/v2/cfbenchmarks/";
const mappings = {
  "not-found": [404, "not_found"], "rate-limit": [429, "too_many_requests"],
  authorization: [503, "service_unavailable"], server: [503, "service_unavailable"],
  timeout: [503, "service_unavailable"], client: [400, "bad_request"]
};

// Independent obligations, never loaded from the fixture or an import template.
// Each identity binds a specific input behavior, including negative defect class.
function obligations() {
  const result = [];
  const add = (name, kind, contractId, check) => result.push({
    caseId: `${sourceId}:${name}`, name, kind, contractId, check
  });
  const same = (a, b) => assert.deepEqual(a, b, "designated CF behavior input");
  for (let i = 0; i < ids.length; i++) {
    add(`request-${i}`, "request", ids[i], (v) => {
      same(v.providerPath, paths[i]); same(v.queryPairs, [["id", "UNLISTED_INDEX"]]);
      same(v.credentialsProvided, true);
    });
    add(`signing-${i}`, "signing", ids[i], (v) => {
      same(v.pathname, prefix + paths[i]); same(v.method, "GET");
      same(v.timestampMs, "1791806400000"); same(v.query, "id=UNLISTED_INDEX");
      same(v.candidateMessage, "1791806400000GET" + prefix + paths[i]);
    });
  }
  for (const [name, providerPath, queryPairs] of [
    ["unicode", "arbitrary/\u96ea &+", [["other", "\u96ea +%/&= "], ["empty", ""]]],
    ["pairs", "values", [["id", "X"], ["id", "Y"], ["custom", ""], ["id", "X"]]],
    ["ignore", "values", [["includeVerification", "true"], ["includeVerification", "false"], ["includeVerification", ""], ["includeVerification", "anything"], ["IncludeVerification", "true"], ["includeverification", "false"]]],
    ["empty-query", "values", []]
  ]) add(`request-${name}`, "request", ids[2], (v) => {
    same(v.providerPath, providerPath); same(v.queryPairs, queryPairs); same(v.credentialsProvided, true);
  });
  const badPaths = ["", "/values", "values/", "a//b", ".", "..", "a/../b", "a/./b",
    "https://evil.test/values", "//evil.test/values", "http:values", "a\\b", "a?x=1", "a#x",
    "%2fvalues", "%2e%2e/values", "%252e%252e/values", "a\u0000b", "a\nb", "a\u007fb"];
  badPaths.forEach((p, i) => add(`path-${i}`, "request", ids[2], (v) => {
    same(v.providerPath, p); same(v.queryPairs, []); same(v.credentialsProvided, true);
  }));
  const badQueries = [{ id: "X" }, [["id"]], [["id", 1]], [["id", "X", "extra"]], ["id=X"], [["id", "\ud800"]]];
  badQueries.forEach((q, i) => add(`query-${i}`, "request", ids[2], (v) => {
    same(v.providerPath, "values"); same(v.queryPairs, q); same(v.credentialsProvided, true);
  }));
  add("missing-credentials", "request", ids[0], (v) => {
    same(v.providerPath, "values"); same(v.queryPairs, []); same(v.credentialsProvided, false);
  });
  for (const [name, candidate] of [
    ["query-in-preimage", "1791806400000GET" + prefix + "values?id=X"],
    ["wrong-method", "1791806400000POST" + prefix + "values"],
    ["wrong-path", "1791806400000GET/trade-api/v2/values"]
  ]) add(`signing-${name}`, "signing", ids[0], (v) => {
    same(v.pathname, prefix + "values"); same(v.timestampMs, "1791806400000");
    same(v.method, "GET"); same(v.query, "id=X"); same(v.candidateMessage, candidate);
  });
  for (const [name, data] of [
    ["object", { arbitrary: "opaque" }], ["array", [1, { arbitrary: true }]],
    ["string", "1.0000000000000000001"], ["number", 123], ["boolean", false], ["null", null]
  ]) add(`envelope-${name}`, "envelope", ids[1], (v) => same(v.body, { data, extra: { retained: true } }));
  for (const [name, body] of [["missing-data", { extra: 1 }], ["array-root", []], ["null-root", null]]) {
    add(`envelope-${name}`, "envelope", ids[1], (v) => same(v.body, body));
  }
  for (const [condition, [status, code]] of Object.entries(mappings)) {
    for (const valid of [true, false]) add(`mapping-${condition}-${valid}`, "mapping", ids[0], (v) => {
      same(v.condition, condition); same(v.status, valid ? status : 418);
      same(v.code, code); same(v.upstreamDetail, "opaque upstream detail");
    });
  }
  for (const [name, status, format] of [["json", 401, "json"], ["text", 403, "text"], ["binary", 599, "binary"], ["empty", 502, "empty"],
    ["not-found", 404, "json"], ["rate-limit", 429, "text"], ["unavailable", 503, "binary"], ["bad-request", 400, "empty"]]) {
    add(`error-${name}`, "error", ids[2], (v) => {
      same(v.status, status); same(v.format, format);
      same(v.headers, { "x-synthetic": "retained" });
      same(v.rawBase64, { json: "eyJhbnkiOiJzaGFwZSJ9", text: "b3BhcXVl", binary: "AP+A", empty: "" }[format]);
    });
  }
  for (const [name, value] of [["positive", 50], ["wrong-cost", 10], ["wrong-method", "POST"], ["wrong-auth", "none"], ["wrong-prefix", "/trade-api/v2/"]]) {
    add(`metadata-${name}`, "metadata", ids[0], (v) => {
      same(v.method, name === "wrong-method" ? value : "GET");
      same(v.auth, name === "wrong-auth" ? value : "api-key");
      same(v.prefix, name === "wrong-prefix" ? value : prefix);
      same(v.rateCost, { bucket: "Read", tokens: name === "wrong-cost" ? value : 50 });
    });
  }
  return result;
}

module.exports = { sourceId, ids, paths, prefix, mappings, obligations };
