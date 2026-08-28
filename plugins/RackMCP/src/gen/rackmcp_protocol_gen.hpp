// GENERATED FILE - DO NOT EDIT.
// Source of truth: packages/schemas (Zod). Regenerate with `pnpm run gen`.
#pragma once
#include <cstddef>
#include <cstdint>

namespace rackmcp {
namespace gen {

static const int BRIDGE_PROTOCOL_VERSION = 1;
static const int BRIDGE_PROTOCOL_MIN_SUPPORTED = 1;

// Limits (spec section 13)
static const int64_t LIMIT_BRIDGE_FRAME_BYTES = 1048576;
static const int64_t LIMIT_MCP_RESULT_BYTES = 4194304;
static const int64_t LIMIT_TXN_MAX_OPERATIONS = 128;
static const int64_t LIMIT_TXN_MAX_ADDED_MODULES = 32;
static const int64_t LIMIT_MAX_ACTIVE_PROBES = 16;
static const int64_t LIMIT_PROBE_MAX_HZ = 20;
static const int64_t LIMIT_PARAM_CHANGES_PER_SECOND = 30;
static const int64_t LIMIT_CONFIRMATION_LIFETIME_MS = 300000;
static const int64_t LIMIT_COMMAND_TIMEOUT_MS = 5000;
static const int64_t LIMIT_PATCH_IO_TIMEOUT_MS = 60000;
static const int64_t LIMIT_IDEMPOTENCY_CACHE_MS = 600000;
static const int64_t LIMIT_JSON_MAX_DEPTH = 64;
static const int64_t LIMIT_JSON_MAX_STRING_BYTES = 262144;
static const int64_t LIMIT_JSON_MAX_TOTAL_NODES = 250000;
static const int64_t LIMIT_BRIDGE_HEARTBEAT_INTERVAL_MS = 2000;
static const int64_t LIMIT_INSTANCE_STALE_AFTER_MS = 10000;
static const int64_t LIMIT_PUMP_COMMANDS_PER_FRAME = 4;
static const int64_t LIMIT_PUMP_FRAME_BUDGET_MS = 4;
static const int64_t LIMIT_PROBE_WINDOW_MS = 50;
static const int64_t LIMIT_PROBE_INPUTS_PER_MODULE = 8;

// Stable error codes (spec section 12)
enum class ErrorCode {
	RACK_NOT_FOUND,
	RACK_DISCONNECTED,
	BRIDGE_NOT_READY,
	WRITER_LEASE_REQUIRED,
	AUTHENTICATION_FAILED,
	PROTOCOL_VERSION_MISMATCH,
	STALE_SESSION,
	STALE_PATCH_EPOCH,
	PATCH_CONFLICT,
	MODEL_NOT_INSTALLED,
	MODULE_NOT_FOUND,
	CABLE_NOT_FOUND,
	PARAMETER_NOT_FOUND,
	PORT_NOT_FOUND,
	VALIDATION_FAILED,
	CONFIRMATION_REQUIRED,
	CONFIRMATION_EXPIRED,
	PATH_NOT_ALLOWED,
	TRANSACTION_TOO_LARGE,
	ROLLBACK_FAILED,
	TIMEOUT,
	UNSUPPORTED_OPERATION,
	OPAQUE_STATE_UNSUPPORTED,
	TELEMETRY_UNAVAILABLE,
	BAD_REQUEST,
	RATE_LIMITED,
	LEASE_HELD,
	INSTANCE_NOT_SELECTED,
	RESULT_TOO_LARGE,
	INTERNAL,
	COUNT_
};

inline const char* errorCodeToString(ErrorCode c) {
	switch (c) {
		case ErrorCode::RACK_NOT_FOUND: return "RACK_NOT_FOUND";
		case ErrorCode::RACK_DISCONNECTED: return "RACK_DISCONNECTED";
		case ErrorCode::BRIDGE_NOT_READY: return "BRIDGE_NOT_READY";
		case ErrorCode::WRITER_LEASE_REQUIRED: return "WRITER_LEASE_REQUIRED";
		case ErrorCode::AUTHENTICATION_FAILED: return "AUTHENTICATION_FAILED";
		case ErrorCode::PROTOCOL_VERSION_MISMATCH: return "PROTOCOL_VERSION_MISMATCH";
		case ErrorCode::STALE_SESSION: return "STALE_SESSION";
		case ErrorCode::STALE_PATCH_EPOCH: return "STALE_PATCH_EPOCH";
		case ErrorCode::PATCH_CONFLICT: return "PATCH_CONFLICT";
		case ErrorCode::MODEL_NOT_INSTALLED: return "MODEL_NOT_INSTALLED";
		case ErrorCode::MODULE_NOT_FOUND: return "MODULE_NOT_FOUND";
		case ErrorCode::CABLE_NOT_FOUND: return "CABLE_NOT_FOUND";
		case ErrorCode::PARAMETER_NOT_FOUND: return "PARAMETER_NOT_FOUND";
		case ErrorCode::PORT_NOT_FOUND: return "PORT_NOT_FOUND";
		case ErrorCode::VALIDATION_FAILED: return "VALIDATION_FAILED";
		case ErrorCode::CONFIRMATION_REQUIRED: return "CONFIRMATION_REQUIRED";
		case ErrorCode::CONFIRMATION_EXPIRED: return "CONFIRMATION_EXPIRED";
		case ErrorCode::PATH_NOT_ALLOWED: return "PATH_NOT_ALLOWED";
		case ErrorCode::TRANSACTION_TOO_LARGE: return "TRANSACTION_TOO_LARGE";
		case ErrorCode::ROLLBACK_FAILED: return "ROLLBACK_FAILED";
		case ErrorCode::TIMEOUT: return "TIMEOUT";
		case ErrorCode::UNSUPPORTED_OPERATION: return "UNSUPPORTED_OPERATION";
		case ErrorCode::OPAQUE_STATE_UNSUPPORTED: return "OPAQUE_STATE_UNSUPPORTED";
		case ErrorCode::TELEMETRY_UNAVAILABLE: return "TELEMETRY_UNAVAILABLE";
		case ErrorCode::BAD_REQUEST: return "BAD_REQUEST";
		case ErrorCode::RATE_LIMITED: return "RATE_LIMITED";
		case ErrorCode::LEASE_HELD: return "LEASE_HELD";
		case ErrorCode::INSTANCE_NOT_SELECTED: return "INSTANCE_NOT_SELECTED";
		case ErrorCode::RESULT_TOO_LARGE: return "RESULT_TOO_LARGE";
		case ErrorCode::INTERNAL: return "INTERNAL";
		default: return "INTERNAL";
	}
}

// Frame kinds and their required non-discriminator fields
struct FieldSpec { const char* name; const char* jsonType; };
struct FrameSpec { const char* kind; const FieldSpec* fields; size_t fieldCount; };

static const FieldSpec FRAME_FIELDS_auth[] = {
	{"hmac", "string"},
	{nullptr, nullptr}
};
static const FieldSpec FRAME_FIELDS_authResult[] = {
	{"ok", "boolean"},
	{nullptr, nullptr}
};
static const FieldSpec FRAME_FIELDS_evt[] = {
	{"event", "string"},
	{nullptr, nullptr}
};
static const FieldSpec FRAME_FIELDS_hello[] = {
	{"client", "object"},
	{"versions", "array"},
	{nullptr, nullptr}
};
static const FieldSpec FRAME_FIELDS_ping[] = {
	{"id", "string"},
	{nullptr, nullptr}
};
static const FieldSpec FRAME_FIELDS_pong[] = {
	{"id", "string"},
	{nullptr, nullptr}
};
static const FieldSpec FRAME_FIELDS_req[] = {
	{"deadlineMs", "integer"},
	{"id", "string"},
	{"method", "string"},
	{"payload", "any"},
	{nullptr, nullptr}
};
static const FieldSpec FRAME_FIELDS_res[] = {
	{"id", "string"},
	{"ok", "boolean"},
	{nullptr, nullptr}
};
static const FieldSpec FRAME_FIELDS_welcome[] = {
	{"authRequired", "boolean"},
	{"bridgeVersion", "string"},
	{"instanceId", "string"},
	{"nonce", "string"},
	{"patchEpoch", "integer"},
	{"rackEdition", "string"},
	{"rackVersion", "string"},
	{"sessionId", "string"},
	{"version", "number"},
	{nullptr, nullptr}
};
static const FrameSpec FRAME_SPECS[] = {
	{"auth", FRAME_FIELDS_auth, 1},
	{"authResult", FRAME_FIELDS_authResult, 1},
	{"evt", FRAME_FIELDS_evt, 1},
	{"hello", FRAME_FIELDS_hello, 2},
	{"ping", FRAME_FIELDS_ping, 1},
	{"pong", FRAME_FIELDS_pong, 1},
	{"req", FRAME_FIELDS_req, 4},
	{"res", FRAME_FIELDS_res, 2},
	{"welcome", FRAME_FIELDS_welcome, 9},
};
static const size_t FRAME_SPEC_COUNT = 9;

// Bridge methods, whether they mutate, and required request fields
struct MethodSpec { const char* method; bool mutating; const FieldSpec* fields; size_t fieldCount; };

static const FieldSpec METHOD_FIELDS_0[] = {
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_1[] = {
	{"clientName", "string"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_2[] = {
	{"leaseId", "string"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_3[] = {
	{"leaseId", "string"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_4[] = {
	{"limit", "integer"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_5[] = {
	{"modelSlug", "string"},
	{"pluginSlug", "string"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_6[] = {
	{"includeOpaqueState", "boolean"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_7[] = {
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_8[] = {
	{"includeOpaqueState", "boolean"},
	{"moduleId", "string"},
	{"scope", "object"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_9[] = {
	{"label", "string"},
	{"operations", "array"},
	{"scope", "object"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_10[] = {
	{"expectedFingerprint", "string"},
	{"operationId", "string"},
	{"plan", "object"},
	{"planHash", "string"},
	{"scope", "object"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_11[] = {
	{"expectedOperationId", "string"},
	{"operationId", "string"},
	{"scope", "object"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_12[] = {
	{"operationId", "string"},
	{"path", "string"},
	{"scope", "object"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_13[] = {
	{"operationId", "string"},
	{"path", "string"},
	{"scope", "object"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_14[] = {
	{"operationId", "string"},
	{"path", "string"},
	{"scope", "object"},
	{"setPath", "boolean"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_15[] = {
	{"operationId", "string"},
	{"scope", "object"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_16[] = {
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_17[] = {
	{"probeInputId", "integer"},
	{"probeModuleId", "string"},
	{"scope", "object"},
	{nullptr, nullptr}
};
static const FieldSpec METHOD_FIELDS_18[] = {
	{nullptr, nullptr}
};
static const MethodSpec METHOD_SPECS[] = {
	{"status.get", false, METHOD_FIELDS_0, 0},
	{"lease.acquire", false, METHOD_FIELDS_1, 1},
	{"lease.renew", false, METHOD_FIELDS_2, 1},
	{"lease.release", false, METHOD_FIELDS_3, 1},
	{"catalog.listModels", false, METHOD_FIELDS_4, 1},
	{"catalog.inspectModel", false, METHOD_FIELDS_5, 2},
	{"patch.snapshot", false, METHOD_FIELDS_6, 1},
	{"patch.fingerprint", false, METHOD_FIELDS_7, 0},
	{"module.inspect", false, METHOD_FIELDS_8, 3},
	{"txn.preview", false, METHOD_FIELDS_9, 3},
	{"txn.commit", true, METHOD_FIELDS_10, 5},
	{"txn.undoLast", true, METHOD_FIELDS_11, 3},
	{"patchfile.save", true, METHOD_FIELDS_12, 3},
	{"patchfile.saveCopy", true, METHOD_FIELDS_13, 3},
	{"patchfile.load", true, METHOD_FIELDS_14, 4},
	{"patchfile.clear", true, METHOD_FIELDS_15, 2},
	{"probe.list", false, METHOD_FIELDS_16, 0},
	{"probe.read", false, METHOD_FIELDS_17, 3},
	{"metrics.get", false, METHOD_FIELDS_18, 0},
};
static const size_t METHOD_SPEC_COUNT = 19;

// Patch operations and required fields
struct OperationSpec { const char* op; const FieldSpec* fields; size_t fieldCount; };

static const FieldSpec OP_FIELDS_0[] = {
	{"alias", "string"},
	{"modelSlug", "string"},
	{"placement", "string"},
	{"pluginSlug", "string"},
	{nullptr, nullptr}
};
static const FieldSpec OP_FIELDS_1[] = {
	{"input", "object"},
	{"inputPolicy", "string"},
	{"output", "object"},
	{nullptr, nullptr}
};
static const FieldSpec OP_FIELDS_2[] = {
	{"cable", "object"},
	{nullptr, nullptr}
};
static const FieldSpec OP_FIELDS_3[] = {
	{"policy", "string"},
	{"port", "object"},
	{nullptr, nullptr}
};
static const FieldSpec OP_FIELDS_4[] = {
	{"alias", "string"},
	{"copyCables", "boolean"},
	{"module", "any"},
	{"placement", "string"},
	{nullptr, nullptr}
};
static const FieldSpec OP_FIELDS_5[] = {
	{"collision", "string"},
	{"module", "any"},
	{"position", "object"},
	{nullptr, nullptr}
};
static const FieldSpec OP_FIELDS_6[] = {
	{"module", "any"},
	{nullptr, nullptr}
};
static const FieldSpec OP_FIELDS_7[] = {
	{"allowLastBridge", "boolean"},
	{"cablePolicy", "string"},
	{"module", "any"},
	{nullptr, nullptr}
};
static const FieldSpec OP_FIELDS_8[] = {
	{"module", "any"},
	{nullptr, nullptr}
};
static const FieldSpec OP_FIELDS_9[] = {
	{"bypassed", "boolean"},
	{"module", "any"},
	{nullptr, nullptr}
};
static const FieldSpec OP_FIELDS_10[] = {
	{"module", "any"},
	{"paramId", "integer"},
	{nullptr, nullptr}
};
static const OperationSpec OPERATION_SPECS[] = {
	{"add_module", OP_FIELDS_0, 4},
	{"connect", OP_FIELDS_1, 3},
	{"disconnect", OP_FIELDS_2, 1},
	{"disconnect_port", OP_FIELDS_3, 2},
	{"duplicate_module", OP_FIELDS_4, 4},
	{"move_module", OP_FIELDS_5, 3},
	{"randomize_module", OP_FIELDS_6, 1},
	{"remove_module", OP_FIELDS_7, 3},
	{"reset_module", OP_FIELDS_8, 1},
	{"set_bypass", OP_FIELDS_9, 2},
	{"set_parameter", OP_FIELDS_10, 2},
};
static const size_t OPERATION_SPEC_COUNT = 11;

} // namespace gen
} // namespace rackmcp
