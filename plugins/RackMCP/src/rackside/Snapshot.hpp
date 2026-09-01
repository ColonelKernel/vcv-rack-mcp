#pragma once
// Patch snapshot and catalog builders (spec section 5). UI thread only:
// these read live Rack engine/widget state. Opaque module `data` is excluded
// unless explicitly requested. All values are serialized as jansson json_t.
#include <string>

typedef struct json_t json_t;

namespace rackmcp {

/** Full patch snapshot. Caller owns the returned json_t. */
json_t* buildPatchSnapshot(bool includeOpaqueState);

/** One module's detailed snapshot, or NULL when the id is unknown. */
json_t* buildModuleSnapshot(int64_t moduleId, bool includeOpaqueState);

/** Canonical SHA-256 fingerprint of the complete serialized patch. */
std::string computePatchFingerprint();

/** Paginated installed-model catalog. Caller owns the returned json_t. */
json_t* buildModelCatalog(const std::string& cursor, int limit, const std::string& query);

/** Parameter/port metadata for one installed model via temporary instantiation. */
json_t* inspectModelMetadata(const std::string& pluginSlug, const std::string& modelSlug,
                             std::string& errorCode);

} // namespace rackmcp
