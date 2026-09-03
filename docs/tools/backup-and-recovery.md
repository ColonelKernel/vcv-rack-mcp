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
| Linux | `~/.local/share/Rack2` |

There is no separate discovery- or checkpoint-directory environment variable —
every subdirectory is derived from the user dir. Point `RACKMCP_RACK_USER_DIR`
at a scratch Rack profile and your checkpoints, discovery manifests, and audit
log all move with it.

## Checkpoints

A checkpoint is a full, standalone copy of the current patch written into the
checkpoints root. Creating one is non-disruptive: `create_checkpoint` writes the
copy **without changing the current patch path and without altering the "saved"
state** of the live patch. Under the hood the plugin calls Rack's
`APP->patch->save()` — through the temp-file-and-rename dance described under
[saving](#saving) — which serializes the current patch and nothing else: it does
not adopt the path or mark history clean.

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
runs under the 60-second patch-file timeout.

Retry a failed `create_checkpoint` with a **fresh** `operationId`. The plugin's
idempotency cache is keyed by the operation id *and* a fingerprint of the
request, and `create_checkpoint` derives a new timestamped path on every call, so
a second attempt under the same id is a different request and is refused with
`BAD_REQUEST` ("operationId was already used for a different request"). Retrying
with a fresh id simply writes another checkpoint file, which is harmless —
`replayed: true` is therefore not something you will see from this tool in
practice.

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
replaces the whole patch. The returned token expires after **5 minutes**, is
single-use, and is minted with kind `restore`: it is not interchangeable with a
`preview_load_patch` token, and the commit refuses it unless its bound path is
exactly the `checkpointPath` you passed on the second call. See
[confirmation tokens](#confirmation-tokens-for-load-clear-and-restore).

## Automatic recovery checkpoints

Before any load, clear, or restore **commit**, the server automatically writes a
recovery checkpoint of the current patch — labeled `recovery` — into the
checkpoints root, so the state you are about to overwrite is never lost. The
preview for each of these operations advertises the plan up front:

- `willCreateRecoveryCheckpoint: true`
- `recoveryCheckpointImpossibleReason: null` — always, see below

Per the spec, the recovery checkpoint is created **unless the preview explicitly
reports why it is impossible** — and every preview here promises one. So in the
commit path the recovery save is **not** best-effort: if it fails, the commit
aborts and the load, clear, or restore **does not happen**. The error carries the
underlying cause's code and a message naming it, e.g.

```
INTERNAL: the recovery checkpoint could not be created (INTERNAL: save failed: …),
so the load was not performed; make the checkpoints directory writable with free
space, then retry
```

Nothing has mutated at that point and the confirmation token has not been burned,
so fixing the cause (usually a full or unwritable checkpoints directory) and
re-sending the same commit works. On a commit that succeeds,
`recoveryCheckpointPath` always holds the absolute path of the just-written
recovery file — it is never `null` — and it is the anchor for the
[recover-from-a-bad-load](#procedure-recover-from-a-bad-load) procedure below.

The preview still reports `recoveryCheckpointImpossibleReason: null`
unconditionally: the server does not probe the checkpoints directory ahead of
time, so a preview cannot warn you that the checkpoint will fail. The refusal at
commit is what protects the patch.

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

**Writes never truncate the previous file.** `save_patch` and `create_checkpoint`
both go through the same routine: Rack's patch manager archives into a sibling
temp file — the target path plus a `.tmp-<pid>` suffix — which is then flushed to
stable storage (`fsync`, or `FlushFileBuffers` on Windows) and moved over the
target. A crash, a disk-full, or a failed flush part-way through therefore leaves
the previous `.vcv` exactly as it was, and the tool reports `INTERNAL` rather than
handing you a half-written archive. Two consequences:

- A filesystem that refuses `fsync` turns a save that previously appeared to
  succeed into an error.
- A hard kill mid-save can leave a `mypatch.vcv.tmp-4711` file beside the patch.
  Nothing sweeps those; `list_patch_files` never shows them (it lists only
  `.vcv` names) and they are deleted on any failure the plugin handles, so a
  stray one is safe to remove by hand.

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
  `willCreateRecoveryCheckpoint`, `recoveryCheckpointImpossibleReason`,
  `willInsertBridgeModule`, a `risk` block flagged `replaces_patch`, and
  `warnings`) plus a `confirmation` (token + 5-minute expiry). If the current
  patch has unsaved changes, that appears in the risk reasons and warnings.
- **`commit_load_patch`** — inputs `confirmationToken` and `operationId`
  (both required). In order: it verifies the token binds to this instance,
  session and a *load*; re-reads the live patch epoch and fingerprint and refuses
  if either moved since the preview; acquires the lease; writes the recovery
  checkpoint (aborting if that fails); burns the token; then loads the file with
  the path adopted as current and **bumps the patch epoch**. Output includes the
  new `fingerprint`, `patchEpoch`, `patchName`, `bridgeModulePresent`, and
  `recoveryCheckpointPath`.

### Clear

- **`preview_clear_patch`** — no parameters. Same preview/confirmation shape, with
  the risk flagged `clears_patch`.
- **`commit_clear_patch`** — inputs `confirmationToken` and `operationId`. Runs
  the same token and live-state checks as the load commit, writes the recovery
  checkpoint, clears the patch (and empties the current path), and bumps the
  patch epoch.

After both load and clear, the plugin guarantees the resulting patch contains a
Bridge module: if the loaded file (or the freshly cleared rack) lacks one, a
Bridge is reinserted and the action is disclosed in the result `warnings`
("inserted a RackMCP-Bridge module so the patch can reconnect after restart").
That is why a loaded or cleared patch is always reconnectable, even if the file
on disk was authored without Rack MCP.

Because the server cannot look inside a `.vcv` archive, the **preview** cannot
know whether the target already has a Bridge: it reports
`willInsertBridgeModule: true` for every load, clear, and restore, with
`targetBridgeModulePresent: null` and a warning that states the condition ("a
RackMCP-Bridge module will be inserted into the resulting patch if it does not
already contain one, which changes the layout of the loaded file"). For a target
that already contains a Bridge this over-discloses; the result's
`bridgeModulePresent` and `warnings` tell you what actually happened.

### Confirmation tokens for load, clear, and restore

The token a `preview_load_patch`, `preview_clear_patch`, or `restore_checkpoint`
preview returns is **single-use** and bound to more than the operation kind:

| Bound to | What the commit does with it |
| --- | --- |
| instance + session | a token from another instance, or from a session that has since reconnected, is refused with `CONFIRMATION_REQUIRED` |
| kind — `load`, `clear`, or `restore` | load and restore tokens are **not** interchangeable; each commit accepts only its own kind |
| target path | `restore_checkpoint` also refuses a token whose bound path is not the `checkpointPath` argument it just policy-checked |
| patch epoch at preview time | a patch replaced in between fails with `STALE_PATCH_EPOCH` |
| patch fingerprint at preview time | any other change to the patch fails with `PATCH_CONFLICT` |

Two consequences worth planning for:

- **The commit burns the token.** Re-sending the same `confirmationToken` — a
  retry after a lost response included — fails with `CONFIRMATION_EXPIRED`
  ("confirmation token is unknown, already used, or expired; re-run the
  preview"), even inside the 5-minute window and even with the same
  `operationId`. Re-running the preview is the correct recovery: it reports the
  true current state, so a lost response is never ambiguous.
- **The fingerprint covers the whole serialized patch, UI state included.**
  Turning a knob or dragging a module between the preview and the commit
  invalidates the confirmation. This is the same rule `commit_patch_transaction`
  has always applied, and it is what makes the preview's `currentPatchSaved` fact
  meaningful — but a flow that previews and then waits on a slow human
  confirmation will hit it.

### When a load fails part-way

Rack's patch manager clears the current patch before it reads the archive, so a
load that throws leaves the rack **empty**, not unchanged. The plugin reports
that honestly instead of implying nothing happened: it bumps the patch epoch,
reinserts a Bridge module so the rack is still reachable, and returns `INTERNAL`
with a message naming the new epoch and telling you the recovery checkpoint holds
your previous patch. Restore it with the
[recover-from-a-bad-load](#procedure-recover-from-a-bad-load) procedure.

## Path policy

Every path a caller supplies — to `save_patch`, `preview_load_patch`, or
`restore_checkpoint` — is run through `resolvePatchPath` before any I/O. The
rules (in `apps/mcp-server/src/paths.ts`) are:

1. **No URLs.** Anything matching a `scheme://` prefix, or starting with
   `file:`, is rejected. Patch paths are local filesystem paths only.
2. **No null bytes.** A path containing `\0` is rejected.
3. **`.vcv` only.** The name you pass must end in `.vcv` (case-insensitive).
   The rule is applied to the requested name, not to the resolved target, so an
   in-root alias named `x.vcv` that points at an in-root file with another
   extension is still accepted.
4. **Canonicalize + realpath containment, even for a file that does not exist
   yet.** The deepest *existing* ancestor is resolved with `realpath` and the
   missing remainder re-attached; a final component that is a **dangling**
   symlink is followed with `readlink` and judged by its target. The canonical
   result must live **inside** the patches root or the checkpoints root. That is
   what defeats `..` traversal and symlink escapes — including a dangling link
   inside a root whose target lies outside it — and it means the path a tool
   actually writes to can be a link's target rather than the name you passed.
5. **Resolvable at all.** A path whose canonical form cannot be determined — a
   symlink loop, a non-directory component, an unreadable ancestor — is refused
   ("path could not be resolved") rather than treated as a new in-root file.
6. **Regular files only.** If the target exists it must be a regular file.
7. **Existence.** Load and restore require the file to exist; save allows a new
   file as long as its parent directory exists.

On Windows a reserved device name (`CON`, `NUL`, `COM1`…) or a name ending in a
dot or a space is refused as well, since such a name would silently discard the
patch.

Any violation raises `PATH_NOT_ALLOWED` with a specific message. Containment is
decided before parent-directory existence, so a path outside both roots always
reports the containment error rather than leaking whether some directory exists.
Because `preview_load_patch` validates eagerly, an out-of-policy path is caught
before you ever reach a commit.

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

There is no case where a load, clear, or restore completed but the recovery
checkpoint is missing: if the checkpoint cannot be written the operation is
refused outright (see [automatic recovery
checkpoints](#automatic-recovery-checkpoints)), so the patch you would have lost
is still live. Do not plan around Rack's own autosave as a fallback — the
autosave directory belongs to Rack's patch manager, which clears it as part of
loading a patch, so after a load it reflects the patch that replaced yours.

## Related

- [Tool reference](./tool-reference.md) — full input/output schemas for every
  tool named here.
- [Configuration examples](./configuration-examples.md) — setting
  `RACKMCP_RACK_USER_DIR` and other server environment variables.
- [Specification](../spec/rack-mcp-spec.md) — section 8, patch files and path
  policy.
