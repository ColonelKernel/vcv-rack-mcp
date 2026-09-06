#pragma once
#include <rack.hpp>

extern rack::plugin::Plugin* pluginInstance;

extern rack::plugin::Model* modelBridge;
extern rack::plugin::Model* modelProbe;
extern rack::plugin::Model* modelTutorial;

/** RackMCP bridge implementation version (recorded in every build). */
#define RACKMCP_BRIDGE_VERSION "0.1.0"
