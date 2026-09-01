#pragma once
// Bridge command handlers. Run on the UI thread inside the command pump.
// Each handler receives the parsed request payload (borrowed) and returns a
// complete response frame string.
#include <string>

#include "core/service.hpp"

namespace rackmcp {

/** Dispatches one command and returns the response frame JSON. */
std::string executeCommand(const BridgeCommand& cmd);

} // namespace rackmcp
