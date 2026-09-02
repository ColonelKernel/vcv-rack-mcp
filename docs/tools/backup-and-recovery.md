# Backup and Recovery

Rack MCP treats every destructive patch operation as recoverable. It keeps
copies of your work as **checkpoints**, takes an **automatic recovery
checkpoint** before it loads, clears, or restores a patch, and drives all `.vcv`
file I/O through Rack's own patch manager so the on-disk archive is never
rewritten by hand. This guide explains the checkpoint and patch-file tools, the
path policy that fences them in, the Bridge-persistence rule that keeps a saved
patch reconnectable, and two concrete procedures: backing up before a risky
change, and recovering from a bad load.

The tools referenced here are defined in the [tool reference](./tool-reference.md);
the behavioral rules come from [the specification](../spec/rack-mcp-spec.md)
(section 8). Server-side path policy lives in `apps/mcp-server/src/paths.ts`;
the plugin-side `.vcv` I/O lives in `plugins/RackMCP/src/rackside/PatchFiles.cpp`.

## Where files live

All patch and checkpoint locations derive from the **Rack user directory**. The
server resolves it in `apps/mcp-server/src/config.ts`: the `RACKMCP_RACK_USER_DIR`
environment variable overrides it, otherwise it defaults per platform.

| Location | Path | Purpose |
| --- | --- | --- |
| Rack user dir | `RACKMCP_RACK_USER_DIR`, or the platform default below | Root of everything |
| Patches root | `<RackUserDir>/patches` | Rack's normal saved-patch folder |
| Checkpoints root | `<RackUserDir>/RackMCP/checkpoints` | Rack MCP's backup copies |
| Audit log | `<RackUserDir>/RackMCP/audit` | Recent-operation log |

Platform defaults for the Rack user directory:

| OS | Default |
| --- | --- |
| macOS | `~/Library/Application Support/Rack2` |
| Windows | `%LOCALAPPDATA%\Rack2` |
| Linux | `~/.Rack2` |

There is no separate discovery- or checkpoint-directory environment variable —
every subdirectory is derived from the user dir. Point `RACKMCP_RACK_USER_DIR`
at a scratch Rack profile and your checkpoints, discovery manifests, and audit
log all move with it.

## Checkpoints

A checkpoint is a full, standalone copy of the current patch written into the
checkpoints root. Creating one is non-disruptive: `create_checkpoint` writes the
copy **without changing the current patch path, without touching Rack's autosave,
and without altering the "saved" state** of the live patch. Under the hood the
plugin calls Rack's `APP->patch->save(<checkpoint path>)`, which serializes the
current patch to the given file and nothing else — it does not adopt the path or
mark history clean.

**`create_checkpoint`**

| Input | |
| --- | --- |
| `label` | optional, max 64 chars |
| `operationId` | required (uuid) |

| Output | |
| --- | --- |
| `checkpointPath` | absolute path of the written `.vcv` |
| `fingerprint` | SHA-256 of the patch that was saved |
| `createdAt` | ISO-8601 timestamp |
| `replayed` | `true` if the result came from the idempotency cache |

Checkpoint filenames are timestamp-prefixed and label-suffixed, e.g.
`2026-09-01T18-30-05-123Z_before-filter-swap.vcv`. The label is sanitized to
`[A-Za-z0-9_-]`, truncated to 40 characters, and defaults to `checkpoint` when
omitted, so a label never escapes the checkpoints directory.

Creating a checkpoint requires the **writer lease** (it is a mutating tool) and
runs under the 60-second patch-file timeout. Retries that reuse the same
`operationId` return the cached result within the 10-minute idempotency window,
with `replayed: true`.

> A checkpoint of a patch that has **no** RackMCP-Bridge module carries a
> warning that the copy will not reconnect after a Rack restart — see
> [Bridge persistence](#bridge-persistence). `create_checkpoint` does not insert
> a Bridge; it only records the fact.

### Restoring a checkpoint

`restore_checkpoint` replaces the entire current patch with a previously saved
checkpoint. It is two-phase and mirrors the load flow:

- **Called without `confirmationToken`** — it returns a preview and a
  confirmation token. Nothing changes.
- **Called with the token** — it first takes an automatic recovery checkpoint of
  the *current* state, then loads the checkpoint file.

| Input | |
| --- | --- |
| `checkpointPath` | required, must resolve **inside the checkpoints root** |
| `confirmationToken` | optional (preview omits it; commit supplies it) |
| `operationId` | required (uuid) |

The source path must land in the checkpoints root; a path that resolves anywhere
else is rejected with `PATH_NOT_ALLOWED` ("restore source must be a checkpoint
file"). The preview reports the target size, whether the current patch is saved,
`willCreateRecoveryCheckpoint: true`, and a `high` risk level because the restore
replaces the whole patch. The returned token expires after **5 minutes**.

## Automatic recovery checkpoints

Before any load, clear, or restore **commit**, the server automatically writes a
recovery checkpoint of the current patch — labeled `recovery` — into the
checkpoints root, so the state you are about to overwrite is never lost. The
preview for each of these operations advertises the plan up front:

- `willCreateRecoveryCheckpoint: true`
- `recoveryCheckpointImpossibleReason: null` when a recovery checkpoint can be
  taken (the normal case)

Per the spec, the recovery checkpoint is created **unless the preview explicitly
reports why it is impossible**. In the commit path the recovery save is
best-effort: if it fails, the operation still proceeds and the result's
`recoveryCheckpointPath` comes back `null`. When it succeeds, that field holds
the absolute path of the just-written recovery file — the anchor for the
[recover-from-a-bad-load](#procedure-recover-from-a-bad-load) procedure below.

## Saving

`save_patch` writes the current patch to disk through Rack's patch manager.

| Input | |
| --- | --- |
| `path` | optional; a policy-checked `.vcv` path |
| `operationId` | required (uuid) |

| Output | |
| --- | --- |
| `path`, `fingerprint`, `saved` | where it was written, its fingerprint, `true` |
| `bridgeModulePresent` | whether the saved patch contains a Bridge |
| `warnings`, `replayed` | Bridge-persistence warnings; idempotency-replay flag |

With no `path`, the patch is saved to its **current** path; if the live patch has
never been given a path, the call fails with `PATH_NOT_ALLOWED` ("current patch
has no path; provide one"). With a `path`, the value is canonicalized and
containment-checked (see [path policy](#path-policy)) before anything is written.
On success the plugin adopts the path as the current one and marks Rack's history
clean (`setSaved()`), so the title bar no longer shows unsaved changes.

`save_patch` is annotated **destructive** by the host because it can overwrite an
existing file. Like every write path it requires the writer lease and runs under
the 60-second timeout. If the patch being saved has no Bridge module, the result
carries the "will not reconnect after restart" warning — `save_patch` writes what
is in the rack, it does **not** silently add a Bridge for you.

## Loading and clearing

Loading and clearing are the two ways to replace the current patch, and both are
**two-phase**: a read-only `preview_*` that mutates nothing and mints a
confirmation token, then a `commit_*` that requires the token, the writer lease,
and takes the recovery checkpoint first. All `.vcv` reads go through Rack's patch
manager (`APP->patch->load`) and clears through `APP->patch->clear` — **the
`.vcv` archive is never rewritten directly**.

### Load

- **`preview_load_patch`** — input `path` (required). It eagerly validates the
  path so a policy violation surfaces as `PATH_NOT_ALLOWED` at preview time, and
  returns a `preview` (path, `exists`, `sizeBytes`, `currentPatchSaved`,
  `willCreateRecoveryCheckpoint`, `recoveryCheckpointImpossibleReason`, a `risk`
  block flagged `replaces_patch`, and `warnings`) plus a `confirmation` (token +
  5-minute expiry). If the current patch has unsaved changes, that appears in the
  risk reasons and warnings.
- **`commit_load_patch`** — inputs `confirmationToken` and `operationId`
  (both required). It verifies the token binds to this instance and a load,
  acquires the lease, writes the recovery checkpoint, loads the file with the
  path adopted as current, and **bumps the patch epoch**. Output includes the new
  `fingerprint`, `patchEpoch`, `patchName`, `bridgeModulePresent`, and
  `recoveryCheckpointPath`.

### Clear

- **`preview_clear_patch`** — no parameters. Same preview/confirmation shape, with
  the risk flagged `clears_patch`.
- **`commit_clear_patch`** — inputs `confirmationToken` and `operationId`. Writes
  the recovery checkpoint, clears the patch (and empties the current path), and
  bumps the patch epoch.

After both load and clear, the plugin guarantees the resulting patch contains a
Bridge module: if the loaded file (or the freshly cleared rack) lacks one, a
Bridge is reinserted and the action is disclosed in the result `warnings`
("inserted a RackMCP-Bridge module so the patch can reconnect after restart").
That is why a loaded or cleared patch is always reconnectable, even if the file
on disk was authored without Rack MCP.

## Path policy

Every path a caller supplies — to `save_patch`, `preview_load_patch`, or
`restore_checkpoint` — is run through `resolvePatchPath` before any I/O. The
rules (in `apps/mcp-server/src/paths.ts`) are:

1. **No URLs.** Anything matching a `scheme://` prefix, or starting with
   `file:`, is rejected. Patch paths are local filesystem paths only.
2. **No null bytes.** A path containing `\0` is rejected.
3. **`.vcv` only.** The path must end in `.vcv` (case-insensitive).
4. **Canonicalize + realpath containment.** The path is resolved to an absolute
   path; symlinks are resolved with `realpath` (for a new save target, the parent
   directory is realpath'd and the basename re-attached). The canonical result
   must live **inside** the patches root or the checkpoints root. This is what
   defeats `..` traversal and symlink escapes — a path that resolves outside both
   roots is refused regardless of how it was spelled.
5. **Regular files only.** If the target exists it must be a regular file.
6. **Existence.** Load and restore require the file to exist; save allows a new
   file as long as its parent directory exists.

Any violation raises `PATH_NOT_ALLOWED` with a specific message. Because
`preview_load_patch` validates eagerly, an out-of-policy path is caught before
you ever reach a commit.

## Bridge persistence

A saved `.vcv` patch that contains no **RackMCP-Bridge** module cannot be
controlled after a Rack restart — with no Bridge in the patch, there is nothing
for the MCP server to reconnect to. Rack MCP guards this at several layers:

- **Detection.** The plugin scans the engine for a module whose plugin slug is
  `RackMCP` and model slug is `Bridge` (`patchHasBridge`). The result is surfaced
  as `bridgeModulePresent` on save, load, and clear outputs.
- **Warnings on save.** `save_patch` and `create_checkpoint` warn — but do not
  modify the patch — when the Bridge is absent.
- **Reinsertion on load/clear.** As noted above, load and clear reinsert a Bridge
  when the resulting patch lacks one, and disclose it.
- **Removal guard.** Rack MCP refuses to remove the *last* Bridge module by
  default, so a transaction cannot accidentally strip a patch of its only means
  of reconnecting.
- **Validation.** `validate_patch` raises the `bridge.missing` finding —
  severity `warning`, confidence `certain` — when the snapshot has zero Bridge
  modules, with the suggested repair: add a RackMCP-Bridge module before saving a
  patch you intend to reconnect to.

Run `validate_patch` before a `save_patch` you plan to reopen later; a
`bridge.missing` warning is your cue to add a Bridge first.

## Procedure: back up before a risky change

Use this before any large or exploratory edit (a big `build_patch`, a filter or
routing swap, anything you might want to walk back).

1. **Checkpoint the current state.** Call `create_checkpoint` with a descriptive
   `label`, e.g. `before-filter-swap`. Record the returned `checkpointPath` and
   `fingerprint`.
2. **Make the change.** Run your `preview_patch_transaction` /
   `commit_patch_transaction` (or `build_patch`) as usual.
3. **If the result is wrong, roll back — cheapest option first:**
   - If the change was a single MCP transaction still at the top of Rack's
     history and untouched by manual edits, `undo_last_mcp_transaction` reverses
     it exactly.
   - Otherwise `restore_checkpoint` with the `checkpointPath` from step 1
     (preview, then commit with the token) returns the patch to its pre-change
     state. The restore itself takes a `recovery` checkpoint first, so even the
     rollback is reversible.

## Procedure: recover from a bad load

A load or clear replaced your patch with the wrong thing. The recovery
checkpoint taken automatically before the commit is your safety net.

1. **Find the recovery checkpoint.** The `commit_load_patch` /
   `commit_clear_patch` result contains `recoveryCheckpointPath`. If you still
   have it, use that path directly. If not, call `list_patch_files` with
   `root: "checkpoints"`; the newest `..._recovery.vcv` entry (results are sorted
   newest-first) is the state captured just before the load.
2. **Preview the restore.** Call `restore_checkpoint` with that
   `checkpointPath` and no `confirmationToken`. Confirm the preview's `path`,
   `sizeBytes`, and risk are what you expect.
3. **Commit the restore.** Call `restore_checkpoint` again with the same
   `checkpointPath`, the `confirmationToken` from step 2, and an `operationId`.
   This takes a fresh recovery checkpoint of the bad state (so you can even undo
   the recovery), then reloads your pre-load patch.
4. **Confirm and re-save.** Check `bridgeModulePresent` in the result, then
   `save_patch` to the original path when you are satisfied.

If `recoveryCheckpointPath` was `null` on the failed commit, the automatic
recovery checkpoint could not be written; fall back to the most recent
`create_checkpoint` you took manually, or to Rack's own autosave, which the
recovery flow never touches.

## Related

- [Tool reference](./tool-reference.md) — full input/output schemas for every
  tool named here.
- [Configuration examples](./configuration-examples.md) — setting
  `RACKMCP_RACK_USER_DIR` and other server environment variables.
- [Specification](../spec/rack-mcp-spec.md) — section 8, patch files and path
  policy.
