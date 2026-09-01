#include "plugin.hpp"
#include "rackside/RackBridge.hpp"

rack::plugin::Plugin* pluginInstance = NULL;

/**
 * Deterministic service shutdown. Rack has no plugin-level destroy() callback,
 * so the bridge is stopped from a static destructor: threads are joined and
 * sockets closed without touching any Rack API (safe after Rack teardown).
 */
namespace {
struct ServiceLifecycle {
    ~ServiceLifecycle() { rackmcp::RackBridge::instance().stop(); }
};
static ServiceLifecycle serviceLifecycle;
} // namespace

void init(rack::plugin::Plugin* p) {
    pluginInstance = p;
    p->addModel(modelBridge);
    p->addModel(modelProbe);
    rackmcp::RackBridge::instance().start();
}
