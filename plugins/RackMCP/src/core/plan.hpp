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
#include <set>
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

/**
 * One live module, as plain data.
 *
 * The first piece of `PlanWorld` -- the Rack-free snapshot `validatePlan` will
 * eventually read instead of calling into the engine. It carries only what a
 * caller has been shown to need; a field nothing reads is a claim that a check
 * exists, which is the failure this repo's census gate is built around.
 *
 * A module with no model reads as two empty slugs, which is what makes the
 * predicates below agree with the pointer-chasing versions they replace: the
 * live code guards `m->model && m->model->plugin` before every comparison, and
 * an empty slug matches neither "Core" nor "RackMCP".
 */
struct WorldModule {
    int64_t id;
    std::string pluginSlug;
    std::string modelSlug;
    WorldModule() : id(-1) {}
    WorldModule(int64_t id_, const std::string& plugin, const std::string& model)
        : id(id_), pluginSlug(plugin), modelSlug(model) {}
};

/**
 * A Core audio interface -- the modules whose removal or rewiring can produce
 * a bang in someone's headphones, which is why `touchesAudio` exists.
 *
 * Prefix match on purpose: Core ships `Audio-2`, `Audio-8` and `Audio-16`, and
 * the live code has always matched them with `rfind("Audio", 0) == 0`.
 */
bool isAudioModule(const WorldModule& module);

/**
 * The RackMCP-Bridge module, whose removal severs the control channel the
 * request arrived on. Written out twice in Transaction.cpp -- once in
 * `bridgeModuleCountLive` and once inline in the remove_module branch -- with
 * no test on either copy.
 */
bool isBridgeModule(const WorldModule& module);

/**
 * A model's identity: the plugin slug and model slug Rack resolves it by.
 *
 * A pair rather than a `"plugin/model"` join. `plugin::isSlugValid`
 * (`vendor/Rack-SDK/include/plugin.hpp:32`) permits only alphanumerics, `-`
 * and `_`, so a join would in fact be unambiguous -- but the SDK only
 * *declares* that validator and never promises the loader applies it, and a
 * pair costs the same and needs no such assumption.
 */
struct ModelRef {
    std::string pluginSlug;
    std::string modelSlug;
    ModelRef() {}
    ModelRef(const std::string& plugin, const std::string& model)
        : pluginSlug(plugin), modelSlug(model) {}
    bool operator<(const ModelRef& other) const {
        if (pluginSlug != other.pluginSlug)
            return pluginSlug < other.pluginSlug;
        return modelSlug < other.modelSlug;
    }
};

/**
 * The Rack-free snapshot transaction validation reads instead of calling into
 * the engine.
 *
 * Built by `snapshotWorld` in rackside, which does the Rack reads once, so the
 * validation itself becomes a pure function of plain data and can be tested on
 * three platforms in CI. It grows one field at a time, each with a caller.
 *
 * `installedModels` holds only the models THIS plan names and Rack resolved --
 * not every model on the machine. The whole catalogue was the obvious design
 * and is worse twice over: it is more work than the lookups it replaces (a
 * large install is several thousand models, walked on the UI thread inside one
 * pump step, whether or not the plan adds anything), and reimplementing the
 * lookup invites divergence from `plugin::getModel`, which
 * `docs/spec/rack-mcp-spec.md` requires preview and apply to agree on.
 * Pre-resolving with `getModel` itself makes the same calls in the same order
 * and merely moves them earlier, so its behaviour is preserved by construction
 * rather than by argument -- including its treatment of an empty slug, and its
 * deliberate difference from `getModelFallback`, which neither preview nor
 * apply uses.
 */
struct PlanWorld {
    std::set<ModelRef> installedModels;
    /** Every live module, so a check can ask about the ones a plan removes. */
    std::vector<WorldModule> modules;

    bool modelInstalled(const std::string& pluginSlug, const std::string& modelSlug) const {
        return installedModels.count(ModelRef(pluginSlug, modelSlug)) != 0;
    }
};

/**
 * Bridge modules that would still exist once `removed` is applied.
 *
 * The last-Bridge refusal exists so a transaction cannot sever the control
 * channel the request arrived on. It used to count Bridges live in the engine,
 * which during a preview is the patch as it was BEFORE the plan -- so it never
 * saw a Bridge an earlier operation in the same plan had already removed.
 * With two Bridges installed, a two-operation plan removing both was permitted:
 * each check saw two live Bridges and allowed the removal. The refusal is not a
 * property of one operation, it is a property of the plan.
 */
int remainingBridgeCount(const std::vector<WorldModule>& modules,
                         const std::vector<int64_t>& removed);

#if RACKMCP_HAVE_JANSSON
/**
 * Checks one patch operation against the generated `gen::OPERATION_SPECS`
 * table -- every field the schema declares required, present and of the
 * declared JSON type.
 *
 * That table has existed since the generator was written and had no consumer.
 * Meanwhile the plugin read operation fields through helpers that substitute a
 * default for anything unexpected: `jbool(op, "bypassed", true)` returns the
 * default for a string, a number, a null or a missing key, and
 * `json_integer_value` returns 0 for all four. Several of those defaults point
 * in the destructive direction -- a `set_bypass` frame carrying the string
 * "false" silenced the module, an unrecognised `cablePolicy` selected
 * `remove_attached`, an unrecognised `inputPolicy` selected `replace_all` and
 * deleted the existing cable.
 *
 * `docs/security/threat-model.md` draws boundary 2 at the bridge socket and
 * says the plugin "re-validates every frame afterward". The MCP server's Zod
 * schemas reject all of this first, so nothing the shipped server sends is
 * affected; this is what makes that sentence true for anything else holding
 * the lease.
 *
 * An operation whose `op` is not in the table returns success: reporting it
 * here would replace the UNSUPPORTED_OPERATION the caller should get with a
 * message about fields.
 *
 * @return an empty string when the operation matches its declared shape,
 *         otherwise a message naming the field and what was wrong with it.
 */
std::string checkOperationFields(json_t* op);

/**
 * The same check against any declared field list, so the operation, method and
 * frame tables share one implementation rather than three that can drift.
 *
 * @param what prefix for the message -- the operation, method or frame name.
 */
std::string checkDeclaredFields(const char* what, const gen::FieldSpec* fields, size_t fieldCount,
                                json_t* obj);

/**
 * Reads a required JSON integer that must fit a C++ `int`.
 *
 * The plugin read every port id, parameter id and grid coordinate as
 * `(int) json_integer_value(json_object_get(o, key))`, which has two distinct
 * failure modes and reports neither:
 *
 * - `json_integer_value` returns 0 for a string, a real, a boolean, a null and
 *   an absent key alike. Port 0 and parameter 0 exist on nearly every module,
 *   so a malformed reference addressed a real port rather than being refused.
 * - the cast to `int` happens BEFORE any bounds check, so an id at or above
 *   2^32 wraps into range. `4294967296 + 3` reads as 3 -- a valid index for a
 *   different, real port.
 *
 * `checkOperationFields` covers an operation's top-level fields, but these ids
 * live inside nested objects (`input.portId`, `position.x`, `port.portId`)
 * which the generated table does not describe.
 *
 * @param err set to a message naming the key and the problem when this returns
 *            false; untouched otherwise.
 * @return false without writing `out` when the key is absent, is not a JSON
 *         integer, or does not fit an `int`.
 */
bool readIntField(json_t* obj, const char* key, int& out, std::string& err);

/**
 * The same read, additionally held to the domain the schema declares.
 *
 * Fitting an `int` is not the same as being a legal value. `GridPosition` is
 * x in [-4096, 4096] and y in [-256, 256] (packages/schemas/src/refs.ts), five
 * orders of magnitude narrower than `int`, and the gap is not cosmetic:
 * `layout::gridToPixel` adds Rack's 2000-column origin to the column before
 * scaling it, so `x = INT_MAX` is signed overflow -- undefined behaviour inside
 * Rack's process -- rather than a module placed far away. The MCP server's Zod
 * schemas refuse it first, but the threat model
 * (`docs/security/threat-model.md`, boundary 2) promises the plugin
 * re-validates every frame, and anything else holding the writer lease reaches
 * this path directly.
 *
 * The bounds are passed in from `gen::` constants generated out of the same Zod
 * schema, so the two cannot drift.
 *
 * @param min lowest accepted value, inclusive.
 * @param max highest accepted value, inclusive.
 */
bool readIntField(json_t* obj, const char* key, int& out, std::string& err, int min, int max);

/**
 * Reads a whole `GridPosition` -- both axes, each against its own domain.
 *
 * A helper rather than two calls at each of the three sites that need one,
 * because x and y do NOT share a domain (x is [-4096, 4096], y is [-256, 256]),
 * and a caller pairing the wrong constants would accept every y from 257 to
 * 4096 while looking exactly like a bounds check.
 *
 * @param position the `position` object itself, not the operation containing it.
 * @return false, with `err` naming the axis and the domain, when either axis is
 *         absent, is not an integer, or is outside its range. Neither output is
 *         written unless both axes read cleanly.
 */
bool readGridPosition(json_t* position, int& x, int& y, std::string& err);

/** Which of the three parameter targets a `set_parameter` spec names. */
enum class ParamTargetKind { None, Value, Normalized, Display };

/** A parsed parameter target, or the reason the spec is not one. */
struct ParamTarget {
    ParamTargetKind kind;
    double number;       // Value: raw; Normalized: 0..1
    std::string display; // Display only
    std::string error;   // non-empty when the spec is malformed; kind is None
    ParamTarget() : kind(ParamTargetKind::None), number(0.0) {}
};

/**
 * Reads the parameter target exactly as the schema declares it: "exactly one
 * of raw `value`, `normalized` [0..1], or a supported `display` string"
 * (`packages/schemas/src/operations.ts`, enforced there by `exactlyOneTarget`).
 *
 * The plugin selected a branch with `jhasKey`, which is true for a JSON null,
 * and then read it with `json_number_value`, which returns 0.0 for a null and
 * for a string. So `{"value": null}` set the parameter to 0 -- and
 * `{"value": null, "normalized": 0.8}` set it to 0 while discarding the real
 * target, because the `value` branch had already won. A spec naming no target
 * at all left the value untouched and reported success.
 *
 * Bounds are not checked here: `normalized` outside 0..1 extrapolates past the
 * parameter's range, which is a question about the parameter, not about the
 * shape of the request, and `ParamQuantity` clamps.
 */
ParamTarget readParamTarget(json_t* spec);
#endif

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
