#include "rackside/Telemetry.hpp"

#include <rack.hpp>

#include <plugin.hpp>

#include <algorithm>
#include <jansson.h>

#include "rackside/ProbeModule.hpp"

namespace rackmcp {

using namespace rack;

static json_t* idStr(int64_t id) {
    return json_string(std::to_string(id).c_str());
}

static ProbeModule* asProbe(engine::Module* m) {
    if (m && m->model && m->model->plugin && m->model->plugin->slug == "RackMCP" &&
        m->model->slug == "Probe")
        return dynamic_cast<ProbeModule*>(m);
    return NULL;
}

/** Finds the source output feeding a probe input, if any. */
static bool findSource(int64_t probeModuleId, int inputId, int64_t& srcModule, int& srcPort) {
    for (int64_t cid : APP->engine->getCableIds()) {
        engine::Cable* c = APP->engine->getCable(cid);
        if (c && c->inputModule && c->inputModule->id == probeModuleId && c->inputId == inputId) {
            if (c->outputModule) {
                srcModule = c->outputModule->id;
                srcPort = c->outputId;
                return true;
            }
        }
    }
    return false;
}

json_t* buildProbeList() {
    json_t* slots = json_array();
    std::vector<int64_t> ids = APP->engine->getModuleIds();
    std::sort(ids.begin(), ids.end());
    for (int64_t id : ids) {
        ProbeModule* probe = asProbe(APP->engine->getModule(id));
        if (!probe)
            continue;
        for (int i = 0; i < ProbeModule::NUM_PROBE_INPUTS; i++) {
            engine::Input& in = probe->inputs[ProbeModule::PROBE1_INPUT + i];
            json_t* slot = json_object();
            json_object_set_new(slot, "probeModuleId", idStr(id));
            json_object_set_new(slot, "probeInputId", json_integer(i));
            bool connected = in.isConnected();
            json_object_set_new(slot, "connected", json_boolean(connected));
            if (connected) {
                int64_t srcModule = -1;
                int srcPort = -1;
                if (findSource(id, ProbeModule::PROBE1_INPUT + i, srcModule, srcPort)) {
                    json_object_set_new(slot, "sourceModuleId", idStr(srcModule));
                    json_object_set_new(slot, "sourcePortId", json_integer(srcPort));
                }
            }
            json_array_append_new(slots, slot);
        }
    }
    json_t* root = json_object();
    json_object_set_new(root, "slots", slots);
    return root;
}

json_t* buildProbeReading(int64_t probeModuleId, int probeInputId, std::string& errorCode) {
    ProbeModule* probe = asProbe(APP->engine->getModule(probeModuleId));
    if (!probe) {
        errorCode = "MODULE_NOT_FOUND";
        return NULL;
    }
    if (probeInputId < 0 || probeInputId >= ProbeModule::NUM_PROBE_INPUTS) {
        errorCode = "PORT_NOT_FOUND";
        return NULL;
    }
    ProbeWindowSnapshot snap;
    bool have = probe->published[probeInputId].read(snap);

    engine::Input& in = probe->inputs[ProbeModule::PROBE1_INPUT + probeInputId];
    bool connected = in.isConnected();

    json_t* root = json_object();
    json_object_set_new(root, "probeModuleId", idStr(probeModuleId));
    json_object_set_new(root, "probeInputId", json_integer(probeInputId));
    json_object_set_new(root, "connected", json_boolean(connected));

    if (!have) {
        // No window published yet (module just added or never processed).
        json_object_set_new(root, "channelCount", json_integer(0));
        json_object_set_new(root, "sampleRate",
                            json_real(APP->engine ? APP->engine->getSampleRate() : 44100.0));
        json_object_set_new(root, "windowFrames", json_integer(0));
        json_object_set_new(root, "channels", json_array());
        json_object_set_new(root, "droppedFrames", json_integer(0));
        json_object_set_new(root, "sequence", json_integer(0));
        return root;
    }

    json_object_set_new(root, "channelCount", json_integer(snap.channelCount));
    json_object_set_new(root, "sampleRate", json_real(snap.sampleRate > 0 ? snap.sampleRate : 44100.0));
    json_object_set_new(root, "windowFrames", json_integer(snap.windowFrames));
    json_t* channels = json_array();
    for (int c = 0; c < snap.channelCount && c < PROBE_MAX_CHANNELS; c++) {
        const ChannelStats& s = snap.channels[c];
        json_t* ch = json_object();
        json_object_set_new(ch, "min", json_real(s.minV));
        json_object_set_new(ch, "max", json_real(s.maxV));
        json_object_set_new(ch, "peakAbs", json_real(s.peakAbs));
        json_object_set_new(ch, "rms", json_real(s.rms));
        json_object_set_new(ch, "mean", json_real(s.mean));
        json_object_set_new(ch, "clippedCount", json_integer(s.clipped));
        json_object_set_new(ch, "nonFiniteCount", json_integer(s.nonFinite));
        json_object_set_new(ch, "edgeCount", json_integer(s.risingEdges));
        json_array_append_new(channels, ch);
    }
    json_object_set_new(root, "channels", channels);
    // Always zero, and true: process() accumulates every frame it is handed and
    // publishes when the window fills, so the DSP never discards engine frames.
    // A caller that wants to know whether it MISSED windows -- a reader-side
    // question this producer cannot answer -- compares `sequence` across two
    // reads; the gap is the number of windows published in between.
    json_object_set_new(root, "droppedFrames", json_integer(0));
    json_object_set_new(root, "sequence", json_integer(snap.sequence));
    return root;
}

} // namespace rackmcp
