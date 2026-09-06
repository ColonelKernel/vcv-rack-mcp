# MCP tool reference

> Generated from the canonical tool schemas (`packages/schemas/json/tools.schema.json`) by
> `scripts/gen-tool-reference.ts`. Do not edit by hand — re-run the generator.

Rack MCP exposes **29 tools**. Every tool has a strict input
schema and structured output. Destructive tools mutate the patch and require a valid,
preview-bound confirmation (see the transaction model). Read-only tools never mutate Rack
state. All 64-bit Rack ids cross the boundary as decimal strings.

## Instances, status, and writer lease

### `list_rack_instances`

*List Rack instances* — read-only · idempotent

Discover running VCV Rack instances with the RackMCP plugin loaded, via their local discovery manifests. Reports staleness and which instance is currently selected.

**Input**

_No parameters._

**Output**

- `instances`: object[]
- `discoveryDir`: string _(max length 4096)_

### `select_rack_instance`

*Select Rack instance* — **mutating** · idempotent

Connect to a specific running Rack instance and make it the target of all subsequent tools. Authenticates with the local pairing secret.

**Input**

- `instanceId`: string (uuid) _(required)_

**Output**

- `status`: object
- `connected`: true

### `get_rack_status`

*Get Rack status* — read-only · idempotent

Report connection state, Rack version/edition, patch epoch, patch name, save state, writer-lease ownership, and bridge metrics for the selected instance.

**Input**

_No parameters._

**Output**

- `status`: object | null
- `connected`: boolean
- `selectedInstanceId`: string (uuid) | null
- `server`: object

### `acquire_writer_lease`

*Acquire writer lease* — **mutating** · idempotent

Acquire the single writer lease for the selected Rack instance. All mutations require the lease. Fails with LEASE_HELD when another client holds it.

**Input**

_No parameters._

**Output**

- `leaseId`: string (uuid)
- `expiresInMs`: integer _(≥ 1, ≤ 9007199254740991)_

### `release_writer_lease`

*Release writer lease* — **mutating** · idempotent

Release the writer lease held by this client.

**Input**

_No parameters._

**Output**

- `released`: boolean

## Catalog and inspection (read-only)

### `list_installed_models`

*List installed models* — read-only · idempotent

Enumerate installed plugins and modules (models) in the selected Rack instance, paginated, with optional name filtering.

**Input**

- `cursor`: string _(max length 256)_ _(optional)_
- `limit`: integer _(≥ 1, ≤ 500)_ _(optional)_
- `query`: string _(max length 256)_ _(optional)_

**Output**

- `models`: object[]
- `nextCursor`: string | null
- `totalModels`: integer _(≥ 0, ≤ 9007199254740991)_

### `inspect_model`

*Inspect model* — read-only · idempotent

Return parameter and port metadata for an installed model. Metadata inspection may require temporary engine-module instantiation on the UI thread; this is disclosed and the module is never added to the patch. Results are cached by plugin/model/version.

**Input**

- `pluginSlug`: string _(max length 255)_ _(required)_
- `modelSlug`: string _(max length 255)_ _(required)_

**Output**

- `model`: object
- `params`: object[]
- `inputs`: object[]
- `outputs`: object[]
- `requiredTemporaryInstantiation`: boolean
- `cached`: boolean
- `adapterAvailable`: boolean
- `adapterVersionRange`: string | null

### `get_patch_snapshot`

*Get patch snapshot* — read-only · idempotent

Return the full structured state of the current patch: modules, parameters, ports, cables, positions, expanders, bypass state, fingerprint and warnings. Opaque module state is excluded unless explicitly requested.

**Input**

- `includeOpaqueState`: boolean _(optional)_
- `expectedPatchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_ _(optional)_

**Output**

- `rackVersion`: string _(max length 64)_
- `rackEdition`: "Free" | "Pro" | "unknown"
- `instanceId`: string (uuid)
- `sessionId`: string (uuid)
- `patchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_
- `patchName`: string | null
- `saved`: boolean
- `sampleRate`: number _(≥ 0)_
- `modules`: object[]
- `cables`: object[]
- `bridgeModuleCount`: integer _(≥ 0, ≤ 9007199254740991)_
- `probeModuleCount`: integer _(≥ 0, ≤ 9007199254740991)_
- `fingerprint`: string
- `warnings`: string[]

### `inspect_module`

*Inspect module* — read-only · idempotent

Return detailed state for one module, including parameters with display values, ports with connections, and adapter-backed semantics when available.

**Input**

- `moduleId`: string _(required)_
- `includeOpaqueState`: boolean _(optional)_
- `expectedPatchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_ _(optional)_

**Output**

- `module`: object
- `adapterAvailable`: boolean
- `semanticsConfidence`: "adapter" | "heuristic" | "none"

### `inspect_parameter`

*Inspect parameter* — read-only · idempotent

Return detailed state for one parameter: raw value, range, default, display value and unit, plus adapter semantics when available.

**Input**

- `moduleId`: string _(required)_
- `paramId`: integer _(≥ 0, ≤ 65535)_ _(required)_
- `expectedPatchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_ _(optional)_

**Output**

- `param`: object
- `moduleId`: string
- `adapterRole`: string | null
- `semanticsConfidence`: "adapter" | "heuristic" | "none"

## Analysis (read-only)

### `describe_patch`

*Describe patch* — read-only · idempotent

Explain the current patch's signal flow in plain language: chains from sources to audio destinations, modulation paths, and notable structure. Confidence is labeled; unknown third-party modules are described heuristically.

**Input**

- `expectedPatchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_ _(optional)_

**Output**

- `summary`: string _(max length 8192)_
- `moduleCount`: integer _(≥ 0, ≤ 9007199254740991)_
- `cableCount`: integer _(≥ 0, ≤ 9007199254740991)_
- `chains`: object[]
- `unknownModuleCount`: integer _(≥ 0, ≤ 9007199254740991)_
- `warnings`: string[]

### `validate_patch`

*Validate patch* — read-only · idempotent

Run structural and advisory validation of the current patch. Findings carry stable rule ids, severity, confidence (certain/adapter/heuristic), evidence and suggested repairs.

**Input**

- `expectedPatchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_ _(optional)_

**Output**

- `findings`: object[]
- `rulesRun`: string[]
- `errorCount`: integer _(≥ 0, ≤ 9007199254740991)_
- `warningCount`: integer _(≥ 0, ≤ 9007199254740991)_
- `infoCount`: integer _(≥ 0, ≤ 9007199254740991)_

## Transactions

### `preview_patch_transaction`

*Preview patch transaction* — read-only · idempotent

Validate a structured patch transaction without mutating Rack. Returns the normalized plan, a diff, risk summary, plan hash, base fingerprint and an expiring confirmation token. Nothing is applied.

**Input**

- `label`: string _(min length 1, max length 128)_ _(required)_
- `operations`: object | object | object | object | object | object | object | object | object | object | object[] _(required)_
- `expectedFingerprint`: string _(optional)_
- `expectedPatchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_ _(optional)_

**Output**

- `preview`: object
- `confirmation`: object

### `commit_patch_transaction`

*Commit patch transaction* — **mutating** · **destructive** (needs confirmation) · idempotent

Atomically apply a previously previewed transaction. Requires the exact plan hash and expected base fingerprint; destructive or high-risk plans additionally require the confirmation token. Applies as a single named Rack history action with full rollback on failure. Retries must reuse the same operationId.

**Input**

- `operationId`: string (uuid) _(required)_
- `planHash`: string _(required)_
- `expectedFingerprint`: string _(required)_
- `confirmationToken`: string _(min length 16, max length 512)_ _(optional)_

**Output**

- `operationId`: string (uuid)
- `oldFingerprint`: string
- `newFingerprint`: string
- `patchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_
- `applied`: object[]
- `aliasToModuleId`: object
- `warnings`: string[]
- `undoEligible`: boolean
- `durationMs`: number _(≥ 0)_
- `replayed`: boolean

### `build_patch`

*Build patch* — **mutating** · **destructive** (needs confirmation) · idempotent

High-level convenience: preview a structured operation graph and, when no confirmation is required, commit it in one call. Never bypasses validation or confirmation; risky plans return a token instead of committing.

**Input**

- `label`: string _(min length 1, max length 128)_ _(required)_
- `operations`: object | object | object | object | object | object | object | object | object | object | object[] _(required)_
- `autoCommit`: boolean _(optional)_
- `operationId`: string (uuid) _(required)_
- `expectedPatchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_ _(optional)_

**Output**

- `phase`: "previewed" | "committed"
- `preview`: object
- `confirmation`: object
- `commit`: object

### `undo_last_mcp_transaction`

*Undo last MCP transaction* — **mutating** · **destructive** (needs confirmation) · idempotent

Undo the most recent MCP transaction, only when it is still the top Rack history entry, no manual action followed it, and the current fingerprint matches the recorded post-transaction fingerprint. Refuses rather than undoing unrelated user work.

**Input**

- `operationId`: string (uuid) _(required)_

**Output**

- `undone`: true
- `undoneOperationId`: string (uuid)
- `newFingerprint`: string
- `patchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_

## Patch files and recovery

### `list_patch_files`

*List patch files* — read-only · idempotent

List .vcv patch files inside the configured roots (Rack patches directory and RackMCP checkpoints directory), paginated.

**Input**

- `root`: "patches" | "checkpoints" | "all" _(optional)_
- `cursor`: string _(max length 256)_ _(optional)_
- `limit`: integer _(≥ 1, ≤ 500)_ _(optional)_

**Output**

- `files`: object[]
- `nextCursor`: string | null
- `roots`: object

### `create_checkpoint`

*Create checkpoint* — **mutating** · idempotent

Save a checkpoint copy of the current patch into the RackMCP checkpoints directory without changing the current patch path or save state.

**Input**

- `label`: string _(max length 64)_ _(optional)_
- `operationId`: string (uuid) _(required)_

**Output**

- `checkpointPath`: string _(max length 4096)_
- `fingerprint`: string
- `createdAt`: string (date-time)
- `replayed`: boolean

### `save_patch`

*Save patch* — **mutating** · **destructive** (needs confirmation) · idempotent

Save the current patch to its current path or a policy-checked .vcv path. Warns when the saved patch lacks a Bridge module and therefore cannot reconnect after restart.

**Input**

- `path`: string _(max length 4096)_ _(optional)_
- `operationId`: string (uuid) _(required)_

**Output**

- `path`: string _(min length 1, max length 4096)_
- `fingerprint`: string
- `saved`: true
- `bridgeModulePresent`: boolean
- `warnings`: string[]
- `replayed`: boolean

### `preview_load_patch`

*Preview load patch* — read-only · idempotent

Preview loading a .vcv patch: path policy, unsaved-work risk, recovery-checkpoint plan and a confirmation token. Nothing is loaded.

**Input**

- `path`: string _(min length 1, max length 4096)_ _(required)_

**Output**

- `preview`: object
- `confirmation`: object

### `commit_load_patch`

*Commit load patch* — **mutating** · **destructive** (needs confirmation) · idempotent

Load the previewed patch after automatically creating a recovery checkpoint (unless the preview reported why that is impossible). Replaces the current patch; increments the patch epoch.

**Input**

- `confirmationToken`: string _(min length 16, max length 512)_ _(required)_
- `operationId`: string (uuid) _(required)_

**Output**

- `fingerprint`: string
- `patchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_
- `patchName`: string | null
- `saved`: boolean
- `bridgeModulePresent`: boolean
- `recoveryCheckpointPath`: string | null
- `warnings`: string[]
- `replayed`: boolean

### `preview_clear_patch`

*Preview clear patch* — read-only · idempotent

Preview clearing the current patch, including the recovery-checkpoint plan and a confirmation token. Nothing is cleared.

**Input**

_No parameters._

**Output**

- `preview`: object
- `confirmation`: object

### `commit_clear_patch`

*Commit clear patch* — **mutating** · **destructive** (needs confirmation) · idempotent

Clear the patch after automatically creating a recovery checkpoint (unless the preview reported why that is impossible). Increments the patch epoch.

**Input**

- `confirmationToken`: string _(min length 16, max length 512)_ _(required)_
- `operationId`: string (uuid) _(required)_

**Output**

- `fingerprint`: string
- `patchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_
- `patchName`: string | null
- `saved`: boolean
- `bridgeModulePresent`: boolean
- `recoveryCheckpointPath`: string | null
- `warnings`: string[]
- `replayed`: boolean

### `restore_checkpoint`

*Restore checkpoint* — **mutating** · **destructive** (needs confirmation) · idempotent

Restore a previously created checkpoint. Called without a confirmation token it returns a preview and token only; called with the token it creates a recovery checkpoint of the current state and then loads the checkpoint.

**Input**

- `checkpointPath`: string _(min length 1, max length 4096)_ _(required)_
- `confirmationToken`: string _(min length 16, max length 512)_ _(optional)_
- `operationId`: string (uuid) _(required)_

**Output**

- `phase`: "preview" | "restored"
- `preview`: object
- `confirmation`: object
- `result`: object

## Probe telemetry

### `list_probes`

*List probes* — read-only · idempotent

List RackMCP-Probe modules and their input slots, showing which are connected and to which source ports.

**Input**

_No parameters._

**Output**

- `slots`: object[]
- `attachedCount`: integer _(≥ 0, ≤ 9007199254740991)_
- `maxActiveProbes`: integer _(≥ 1, ≤ 9007199254740991)_

### `preview_attach_probe`

*Preview attach probe* — read-only · idempotent

Preview attaching a Probe input to a source output port via an explicit cable, adding a Probe module if none has a free slot. Returns a plan and confirmation info; nothing is mutated.

**Input**

- `source`: object _(required)_
- `probe`: object _(optional)_
- `expectedPatchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_ _(optional)_

**Output**

- `preview`: object
- `confirmation`: object
- `slot`: object

### `commit_attach_probe`

*Commit attach probe* — **mutating** · idempotent

Apply a previously previewed probe attachment. Signal telemetry is only available through an explicit Probe cable.

**Input**

- `operationId`: string (uuid) _(required)_
- `planHash`: string _(required)_
- `expectedFingerprint`: string _(required)_
- `confirmationToken`: string _(min length 16, max length 512)_ _(optional)_

**Output**

- `commit`: object
- `probeModuleId`: string
- `probeInputId`: integer _(≥ 0, ≤ 65535)_
- `cableId`: string

### `read_probe`

*Read probe* — read-only · idempotent

Read the latest telemetry window from an attached Probe input: per-channel min/max, peak, RMS, DC, clipped and non-finite counts, edge count, window and sample rate. Rate limited to 20 Hz.

**Input**

- `probeModuleId`: string _(required)_
- `probeInputId`: integer _(≥ 0, ≤ 65535)_ _(required)_
- `expectedPatchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_ _(optional)_

**Output**

- `probeModuleId`: string
- `probeInputId`: integer _(≥ 0, ≤ 65535)_
- `connected`: boolean
- `channelCount`: integer _(≥ 0, ≤ 16)_
- `sampleRate`: number
- `windowFrames`: integer _(≥ 0, ≤ 9007199254740991)_
- `channels`: object[]
- `droppedFrames`: integer _(≥ 0, ≤ 9007199254740991)_
- `sequence`: integer _(≥ 0, ≤ 9007199254740991)_

### `detach_probe`

*Detach probe* — **mutating** · idempotent

Disconnect a Probe input's cable(s). The Probe module itself is left in place.

**Input**

- `probeModuleId`: string _(required)_
- `probeInputId`: integer _(≥ 0, ≤ 65535)_ _(required)_
- `operationId`: string (uuid) _(required)_
- `expectedPatchEpoch`: integer _(≥ 1, ≤ 9007199254740991)_ _(required)_

**Output**

- `detached`: true
- `removedCableIds`: string[]
- `newFingerprint`: string
- `replayed`: boolean
