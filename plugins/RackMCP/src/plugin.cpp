#include "rackmcp_plugin.hpp"
#include "rackside/RackBridge.hpp"

rack::plugin::Plugin* pluginInstance = NULL;

void init(rack::plugin::Plugin* p) {
    pluginInstance = p;
    p->addModel(modelBridge);
    p->addModel(modelProbe);
    p->addModel(modelTutorial);
    p->addModel(modelChat);
    rackmcp::RackBridge::instance().start();
}

/**
 * Deterministic service shutdown. Rack calls destroy() on the UI thread before
 * it unloads the plugin library (plugin/callbacks.hpp), with the bridge threads
 * still alive and, on Windows, without the loader lock held. That makes it the
 * only correct place to join threads: a static destructor would run inside
 * FreeLibrary/DllMain(DLL_PROCESS_DETACH), where joining a thread deadlocks,
 * and would in any case run after RackBridge's own destructor. stop() is
 * idempotent, so the RackBridge destructor is a harmless safety net.
 */
void destroy() {
    rackmcp::RackBridge::instance().stop();
}
