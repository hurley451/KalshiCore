const assert = require("node:assert/strict");
const { pointer, resolve } = require("./full-contracts");

// Coverage obligations are independent of authored/bootstrap instance data.
// Names identify required behaviors within a source; values may change while
// still exercising that behavior. Supplementary cases are allowed.
const requirements = {
  perps_openapi: {
    "composed-order": "#/components/schemas/CreateMarginOrderRequest",
    "required-order": "#/components/schemas/CreateMarginOrderRequest",
    error: "#/components/schemas/ErrorResponse",
    "fills-pagination": "#/components/schemas/GetMarginFillsResponse",
    "fills-terminal": "#/components/schemas/GetMarginFillsResponse"
  },
  perps_scm_openapi: {
    error: "#/components/schemas/Error",
    "composed-payment": "#/components/schemas/MemberFundingPayment",
    "payment-pagination": "#/components/schemas/GetMemberFundingPaymentsResponse",
    "payment-terminal": "#/components/schemas/GetMemberFundingPaymentsResponse",
    "pagination-limit": "#/paths/~1margin~1funding_payments/get/parameters/2/schema"
  },
  perps_asyncapi: {
    "root-subscribe": "#/components/schemas/subscribeCommandPayload",
    "control-incoming": "#/components/messages/incomingPing/payload",
    "control-outgoing": "#/components/messages/outgoingPing/payload",
    "data-trade": "#/components/schemas/marginTradePayload",
    "data-trade-timestamp": "#/components/schemas/marginTradePayload"
  }
};

// Operation bindings are separate from editable fixture/bootstrap payloads.
const bindings = {
  perps_openapi: {
    "composed-order": { operation: "#/paths/~1margin~1orders/post", kind: "body" },
    "required-order": { operation: "#/paths/~1margin~1orders/post", kind: "body" },
    error: { operation: "#/paths/~1margin~1orders/post", kind: "response", status: "400" },
    "fills-pagination": { operation: "#/paths/~1margin~1fills/get", kind: "response", status: "200" },
    "fills-terminal": { operation: "#/paths/~1margin~1fills/get", kind: "response", status: "200" }
  },
  perps_scm_openapi: {
    error: { operation: "#/paths/~1margin~1funding_payments/get", kind: "response", status: "400" },
    "composed-payment": { operation: "#/paths/~1margin~1funding_payments/get", kind: "response", status: "200", nested: ["properties", "payments", "items"] },
    "payment-pagination": { operation: "#/paths/~1margin~1funding_payments/get", kind: "response", status: "200" },
    "payment-terminal": { operation: "#/paths/~1margin~1funding_payments/get", kind: "response", status: "200" },
    "pagination-limit": { operation: "#/paths/~1margin~1funding_payments/get", kind: "parameter", name: "limit", location: "query" }
  },
  perps_asyncapi: {
    "root-subscribe": { operation: "#/operations/sendSubscribe", kind: "message", message: "#/channels/root/messages/subscribeCommand", action: "receive" },
    "control-incoming": { operation: "#/operations/sendPing", kind: "message", message: "#/channels/control_frames/messages/incomingPing", action: "receive" },
    "control-outgoing": { operation: "#/operations/receivePing", kind: "message", message: "#/channels/control_frames/messages/outgoingPing", action: "send" },
    "data-trade": { operation: "#/operations/receiveTrade", kind: "message", message: "#/channels/trade/messages/trade", action: "send" },
    "data-trade-timestamp": { operation: "#/operations/receiveTrade", kind: "message", message: "#/channels/trade/messages/trade", action: "send" }
  }
};

function requiredCases(sourceId) {
  assert.ok(Object.hasOwn(requirements, sourceId), `Unknown fixture source ${sourceId}`);
  return Object.entries(requirements[sourceId]).flatMap(([behavior, pointer]) => [true, false].map((valid) => ({
    caseId: `${sourceId}:${behavior}-${valid ? "positive" : "negative"}`,
    name: `${behavior}-${valid ? "positive" : "negative"}`, identity: { sourceId, pointer },
    operation: { sourceId, pointer: bindings[sourceId][behavior].operation },
    binding: bindings[sourceId][behavior], valid, behavior
  })));
}

function assertOperation(required, document) {
  const binding = required.binding;
  const operation = pointer(document, binding.operation);
  let schema;
  switch (binding.kind) {
    case "body": schema = resolve(document, operation.requestBody).content["application/json"].schema; break;
    case "response": schema = resolve(document, operation.responses[binding.status]).content["application/json"].schema; break;
    case "parameter": {
      const parameter = operation.parameters.map((entry) => resolve(document, entry))
        .find((entry) => entry.name === binding.name && entry.in === binding.location);
      assert.ok(parameter, `${required.caseId}: missing operation parameter`);
      schema = parameter.schema;
      break;
    }
    case "message":
      assert.equal(operation.action, binding.action, `${required.caseId}: message direction mismatch`);
      assert.ok(operation.messages.some((message) => message.$ref === binding.message), `${required.caseId}: message outside operation`);
      schema = resolve(document, pointer(document, binding.message)).payload;
      break;
    default: throw new Error(`Unsupported fixture operation binding ${binding.kind}`);
  }
  for (const segment of binding.nested || []) schema = resolve(document, schema)[segment];
  assert.equal(resolve(document, schema), resolve(document, pointer(document, required.identity.pointer)),
    `${required.caseId}: schema is not the designated operation contract`);
}

function assertBehavior(required, entry, errors, validate, schema) {
  const value = entry.value;
  const positive = required.valid;
  const fail = (condition, detail) => assert.ok(condition, `${required.identity.sourceId}/${entry.name}: behavior ${detail}`);
  const nonempty = (item) => typeof item === "string" && item.length > 0;
  const object = (item) => item !== null && typeof item === "object" && !Array.isArray(item);
  const errorAt = (at, keyword, property) => errors.some((error) => error.instancePath === at && error.keyword === keyword &&
    (property === undefined || error.params.missingProperty === property));
  const repaired = (change) => {
    const copy = structuredClone(value); change(copy);
    fail(validate(copy), "negative must become valid when the exercised defect is repaired");
  };

  switch (required.behavior) {
    case "composed-order":
      fail(object(value) && Object.hasOwn(value, "self_trade_prevention_type"), "must exercise the allOf enum field");
      if (!positive) {
        fail(errorAt("/self_trade_prevention_type", "enum"), "must fail the composed enum");
        repaired((copy) => { copy.self_trade_prevention_type = "maker"; });
      }
      break;
    case "required-order":
      if (!positive) fail(errorAt("", "required"), "must fail required order fields");
      break;
    case "error":
      fail(object(value), "must be an error object");
      if (positive) fail(nonempty(value.code) && nonempty(value.message), "must carry error code and message");
      else if (required.identity.sourceId === "perps_scm_openapi") {
        fail(errorAt("", "required", "code") || errorAt("", "required", "message"), "must exercise required SCM error fields");
      } else {
        fail(errors.length > 0 && errors.every((error) => ["/code", "/message", "/details"].includes(error.instancePath) && error.keyword === "type"), "must fail an error field type");
      }
      break;
    case "composed-payment":
      fail(object(value) && Object.hasOwn(value, "settlement_execution_time"), "must exercise the allOf settlement timestamp");
      if (positive) fail(typeof value.settlement_execution_time === "string", "must exercise the nonnull composed timestamp format");
      if (!positive) {
        fail(errorAt("/settlement_execution_time", "format"), "must fail the composed timestamp format");
        repaired((copy) => { copy.settlement_execution_time = "2026-10-12T00:00:00Z"; });
      }
      break;
    case "fills-pagination":
    case "payment-pagination": {
      const collection = required.behavior === "fills-pagination" ? "fills" : "payments";
      fail(object(value) && Array.isArray(value[collection]) && value[collection].length > 0 && nonempty(value.cursor), "must carry a nonempty page and continuation cursor");
      if (!positive) fail(errors.length > 0 && errors.every((error) => error.instancePath.startsWith(`/${collection}/`)), "must fail a page item contract");
      break;
    }
    case "fills-terminal":
      fail(object(value) && Array.isArray(value.fills) && value.fills.length === 0, "must exercise an empty terminal fills page");
      if (positive) fail(value.cursor === "", "must retain the required empty terminal cursor");
      else fail(!Object.hasOwn(value, "cursor") && errorAt("", "required", "cursor"), "must fail the missing required terminal cursor");
      break;
    case "payment-terminal":
      fail(object(value) && Array.isArray(value.payments) && value.payments.length === 0, "must exercise an empty terminal payment page");
      if (positive) fail(!Object.hasOwn(value, "cursor"), "must exercise omission of the optional terminal cursor");
      else fail(errorAt("/cursor", "type"), "must fail the optional cursor type");
      break;
    case "pagination-limit":
      fail(Number.isInteger(value), "must exercise an integer pagination boundary");
      if (positive) fail(value === schema.maximum, "must exercise the inclusive maximum");
      else fail(value > schema.maximum && errorAt("", "maximum"), "must fail above the maximum");
      break;
    case "root-subscribe":
      fail(object(value) && value.cmd === "subscribe" && Array.isArray(value.params?.channels) && value.params.channels.length > 0, "must exercise root channel subscription");
      if (!positive) {
        fail(errors.some((error) => error.instancePath.startsWith("/params/channels/") && error.keyword === "enum"), "must fail the subscription channel enum");
        repaired((copy) => { copy.params.channels = ["trade"]; });
      }
      break;
    case "control-incoming":
    case "control-outgoing":
      fail(typeof value === "string", "must exercise a control frame string payload");
      if (!positive) fail(errorAt("", "const"), "must fail the control frame constant");
      break;
    case "data-trade":
    case "data-trade-timestamp":
      fail(object(value) && value.type === "trade" && object(value.msg), "must exercise a trade data envelope");
      if (!positive) {
        const timestamp = required.behavior === "data-trade-timestamp";
        fail(errorAt(timestamp ? "/msg/ts_ms" : "/msg/taker_side", timestamp ? "type" : "enum"), "must fail the designated trade data field");
        repaired((copy) => { if (timestamp) copy.msg.ts_ms = 1791763200000; else copy.msg.taker_side = "bid"; });
      }
      break;
    default: throw new Error(`Unknown required fixture behavior ${required.behavior}`);
  }
}

module.exports = { requiredCases, assertBehavior, assertOperation };
