#pragma once
// The Rack-free half of transaction validation: id parsing, module-reference
// resolution, cable accounting, and risk classification.
//
// This decides whether the client is asked to confirm before a patch is
// changed, which makes it the safety-relevant output of a preview -- and it
// had no test, because it was written inline in Transaction.cpp between live
// Rack reads. Nothing about the classification needs Rack: it is a function of
// what the plan was found to do.
//
// Flag names come from the generated RiskFlag enum rather than string
// literals, so a flag renamed in packages/schemas/src/operations.ts breaks the
// build here instead of silently emitting a word no client recognises.
#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#if RACKMCP_HAVE_JANSSON
#include <jansson.h>
#endif

#include "gen/rackmcp_protocol_gen.hpp"

namespace rackmcp {

/**
 * Parses a Rack id exactly as packages/schemas/src/refs.ts declares it:
 * DecimalId is `^(0|[1-9][0-9]{0,18})$`, and nothing else is an id.
 *
 * The plugin used strtoll with an `*endp == '\0' && id >= 0` check, which is
 * meaningfully more permissive than that. strtoll("") returns 0 and leaves
 * endp on the terminator, so an EMPTY moduleId was accepted and resolved to
 * module 0 -- a real module on most racks. It also accepted leading
 * whitespace, a leading `+`, leading zeros, and silently clamped an
 * out-of-range value to INT64_MAX rather than rejecting it.
 *
 * The MCP server never sends any of those, because Zod rejects them first. But
 * docs/security/threat-model.md draws boundary 2 at this socket and says the
 * plugin "re-validates every frame afterward", and a parse that disagrees with
 * the declared shape is not re-validation. Anything reaching the bridge has
 * already authenticated, so this is defence in depth rather than a hole being
 * closed -- but the document makes a claim, and this is what makes it true.
 */
bool parseDecimalId(const std::string& text, int64_t& out);

/** A resolved module reference: a live id, or a transaction-local alias. */
struct ModuleRef {
    bool ok;
    bool isAlias;
    int64_t moduleId;
    /** Set whenever the ref named an alias, resolved or not. */
    std::string alias;
    ModuleRef() : ok(false), isAlias(false), moduleId(-1) {}
};

#if RACKMCP_HAVE_JANSSON
/**
 * Resolves `{"moduleId":"N"}` or `{"alias":"name"}` against the aliases an
 * earlier operation in the same plan declared.
 *
 * moduleId wins when both are present, matching the schema's union order and
 * the original's control flow: an object carrying both is not legal input, and
 * silently preferring the alias would let a malformed ref act on a module the
 * caller did not name.
 */
ModuleRef resolveModuleRef(json_t* ref, const std::map<std::string, int64_t>& aliases);
#endif

/** A cable as validation needs to see it. */
struct PlanCable {
    int64_t id;
    /** False when the engine holds the cable with an end detached. */
    bool hasOutput, hasInput;
    int64_t outputModuleId, inputModuleId;
    int outputId, inputId;
    PlanCable()
        : id(-1), hasOutput(false), hasInput(false), outputModuleId(-1), inputModuleId(-1),
          outputId(-1), inputId(-1) {}
    static PlanCable connected(int64_t id, int64_t outModule, int outPort, int64_t inModule,
                               int inPort);
};

/**
 * Cable ids touching `moduleId` at either end, excluding those `removed`
 * already accounts for.
 *
 * Order follows the engine's own cable order, which is semantic: the
 * disconnect_port "top" policy takes the last match.
 */
std::vector<int64_t> cablesOnModule(const std::vector<PlanCable>& cables,
                                    const std::vector<int64_t>& removed, int64_t moduleId);

/** As cablesOnModule, narrowed to one port. `portType` is "input" or "output". */
std::vector<int64_t> cablesOnPort(const std::vector<PlanCable>& cables,
                                  const std::vector<int64_t>& removed, int64_t moduleId,
                                  const std::string& portType, int portId);


/**
 * What validation found the plan would do. Counts rather than lists: risk only
 * ever asks how many, and the diff reports which.
 */
struct PlanEffects {
    bool removesBridge;
    bool touchesAudio;
    bool missingModule;
    bool adapterUncertainty;
    bool possibleFeedback;
    bool randomizes;
    size_t removedModules;
    size_t removedCables;
    size_t replacedInputs;
    size_t stackedInputs;
    size_t operationCount;

    PlanEffects()
        : removesBridge(false), touchesAudio(false), missingModule(false),
          adapterUncertainty(false), possibleFeedback(false), randomizes(false),
          removedModules(0), removedCables(0), replacedInputs(0), stackedInputs(0),
          operationCount(0) {}
};

/** One flag and the sentence shown beside it. */
struct RiskEntry {
    gen::RiskFlag flag;
    std::string reason;
    RiskEntry(gen::RiskFlag flag_, const std::string& reason_) : flag(flag_), reason(reason_) {}
    const char* name() const { return gen::riskFlagToString(flag); }
};

struct PlanRisk {
    /** "low" | "destructive" | "high", the schema's RiskLevel. */
    std::string level;
    bool confirmationRequired;
    std::vector<RiskEntry> entries;
    PlanRisk() : confirmationRequired(false) {}
    bool has(gen::RiskFlag flag) const;
};

/**
 * Classifies a validated plan.
 *
 * `maxOperations` is the per-transaction allowance; a plan using more than half
 * of it is flagged so a client can offer to split, which says nothing about
 * validity. Passed in rather than read from gen:: directly so the threshold is
 * testable at both sides of the boundary.
 *
 * Destructiveness is removal and replacement only. Stacking an input adds a
 * cable beside an existing one and takes nothing away, so it is reported and
 * does not gate. Missing models and adapter uncertainty likewise: they are
 * carried by flags, and the level stays low.
 */
PlanRisk computeRisk(const PlanEffects& effects, int64_t maxOperations);

}  // namespace rackmcp
