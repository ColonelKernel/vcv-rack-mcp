#include <cstddef>
#include <doctest.h>
#include <cstring>
#include "gen/rackmcp_protocol_gen.hpp"

using namespace rackmcp::gen;

TEST_CASE("generated protocol constants match the specification defaults") {
    CHECK(BRIDGE_PROTOCOL_VERSION == 1);
    CHECK(LIMIT_BRIDGE_FRAME_BYTES == 1024 * 1024);
    CHECK(LIMIT_MCP_RESULT_BYTES == 4 * 1024 * 1024);
    CHECK(LIMIT_TXN_MAX_OPERATIONS == 128);
    CHECK(LIMIT_TXN_MAX_ADDED_MODULES == 32);
    CHECK(LIMIT_MAX_ACTIVE_PROBES == 16);
    CHECK(LIMIT_PROBE_MAX_HZ == 20);
    CHECK(LIMIT_PARAM_CHANGES_PER_SECOND == 30);
    CHECK(LIMIT_CONFIRMATION_LIFETIME_MS == 5 * 60 * 1000);
    CHECK(LIMIT_COMMAND_TIMEOUT_MS == 5000);
    CHECK(LIMIT_PATCH_IO_TIMEOUT_MS == 60000);
    CHECK(LIMIT_IDEMPOTENCY_CACHE_MS >= 10 * 60 * 1000);
}

TEST_CASE("error code round trip") {
    CHECK(std::strcmp(errorCodeToString(ErrorCode::RACK_NOT_FOUND), "RACK_NOT_FOUND") == 0);
    CHECK(std::strcmp(errorCodeToString(ErrorCode::TELEMETRY_UNAVAILABLE), "TELEMETRY_UNAVAILABLE") == 0);
}

TEST_CASE("method and operation tables are populated") {
    CHECK(METHOD_SPEC_COUNT == 21);
    CHECK(OPERATION_SPEC_COUNT == 11);
    CHECK(FRAME_SPEC_COUNT == 9);
    bool sawCommit = false;
    for (size_t i = 0; i < METHOD_SPEC_COUNT; i++) {
        if (std::strcmp(METHOD_SPECS[i].method, "txn.commit") == 0) {
            sawCommit = true;
            CHECK(METHOD_SPECS[i].mutating);
        }
    }
    CHECK(sawCommit);
}
