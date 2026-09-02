#pragma once
// Probe telemetry read handlers (spec section 8). UI thread. Signal data is
// available only for inputs fed by an explicit Probe cable — there is no
// arbitrary output-port sampling.
#include <string>

typedef struct json_t json_t;

namespace rackmcp {

/** Enumerates all RackMCP-Probe modules and their input slots. */
json_t* buildProbeList();

/** Reads the latest telemetry window for one probe input, or NULL if unknown. */
json_t* buildProbeReading(int64_t probeModuleId, int probeInputId, std::string& errorCode);

} // namespace rackmcp
