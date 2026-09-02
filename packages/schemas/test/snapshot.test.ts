import { describe, expect, it } from "vitest";
import { CableSnapshot, ModuleSnapshot, ParamSnapshot, PatchSnapshot, PortSnapshot } from "../src/snapshot.js";

/**
 * Locks the snapshot schemas to the exact wire shape emitted by the Rack plugin
 * (plugins/RackMCP/src/rackside/Snapshot.cpp: buildParam / buildPort /
 * buildOneModule / buildPatchSnapshot). If these drift, get_patch_snapshot
 * would return data the declared output schema rejects — the very divergence
 * these schemas exist to prevent. The payloads below mirror that C++ verbatim.
 */

const UUID = "6c5c48b2-3b0f-4f2a-9df9-1f4a30f10a10";
const UUID2 = "6c5c48b2-3b0f-4f2a-9df9-1f4a30f10a11";
const HASH = "a".repeat(64);

// A param backed by a ParamQuantity (the common case): ranges are real numbers.
const PARAM_WITH_PQ = {
  paramId: 0,
  name: "Freq",
  value: 0.5,
  minValue: -1,
  maxValue: 1,
  defaultValue: 0,
  normalizedValue: 0.75,
  displayValue: "440.00 Hz",
  unit: " Hz",
  snapped: false,
};

// A param with no ParamQuantity: Snapshot.cpp nulls every range/display field.
const PARAM_WITHOUT_PQ = {
  paramId: 1,
  name: "",
  value: 0,
  minValue: null,
  maxValue: null,
  defaultValue: null,
  normalizedValue: null,
  displayValue: null,
  unit: "",
  snapped: false,
};

const INPUT_PORT = { portId: 0, type: "input", name: "In", channels: 0, connected: false };
const OUTPUT_PORT = { portId: 0, type: "output", name: "Out", channels: 1, connected: true };

const MODULE = {
  moduleId: "12",
  pluginSlug: "RackMCP",
  pluginVersion: "0.1.0",
  modelSlug: "Bridge",
  modelName: "RackMCP Bridge",
  bypassed: false,
  isBridge: true,
  isProbe: false,
  gridPosition: { x: 0, y: 0 },
  gridWidth: 8,
  params: [PARAM_WITH_PQ, PARAM_WITHOUT_PQ],
  inputs: [INPUT_PORT],
  outputs: [OUTPUT_PORT],
  expanders: { left: null, right: null },
};

const CABLE = {
  cableId: "100",
  outputModuleId: "12",
  outputId: 0,
  inputModuleId: "13",
  inputId: 2,
  color: "#f3374b",
};

const SNAPSHOT = {
  rackVersion: "2.6.6",
  rackEdition: "Pro",
  instanceId: UUID,
  sessionId: UUID2,
  patchEpoch: 1,
  patchName: null,
  saved: true,
  sampleRate: 44100,
  modules: [MODULE],
  cables: [CABLE],
  bridgeModuleCount: 1,
  probeModuleCount: 0,
  fingerprint: HASH,
  warnings: [],
};

describe("snapshot schemas match the bridge wire shape", () => {
  it("accepts a representative full patch snapshot", () => {
    const r = PatchSnapshot.safeParse(SNAPSHOT);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it("accepts both param branches (with and without a ParamQuantity)", () => {
    expect(ParamSnapshot.safeParse(PARAM_WITH_PQ).success).toBe(true);
    expect(ParamSnapshot.safeParse(PARAM_WITHOUT_PQ).success).toBe(true);
  });

  it("accepts a module with no widget (null grid position and width)", () => {
    const noWidget = { ...MODULE, gridPosition: null, gridWidth: null };
    expect(ModuleSnapshot.safeParse(noWidget).success).toBe(true);
  });

  it("accepts opaque state fields only present when disclosed", () => {
    const withOpaque = { ...MODULE, opaqueState: { any: "thing" }, opaqueStateDisclosed: true };
    expect(ModuleSnapshot.safeParse(withOpaque).success).toBe(true);
  });

  it("accepts every color::toHexString form the bridge can emit", () => {
    for (const color of ["#f3374b", "#f3374b80", ""]) {
      expect(CableSnapshot.safeParse({ ...CABLE, color }).success, color).toBe(true);
    }
  });

  it("accepts a live sample rate of 0 (engine not running)", () => {
    expect(PatchSnapshot.safeParse({ ...SNAPSHOT, sampleRate: 0 }).success).toBe(true);
  });

  it("rejects an engine port that reports too many channels", () => {
    expect(PortSnapshot.safeParse({ ...OUTPUT_PORT, channels: 17 }).success).toBe(false);
  });
});

describe("snapshot schemas reject the pre-reconciliation field names", () => {
  it("rejects the old module field names (name/position/sizeHp/*ExpanderModuleId)", () => {
    const legacy = {
      ...MODULE,
      name: MODULE.modelName,
      position: MODULE.gridPosition,
      sizeHp: MODULE.gridWidth,
      leftExpanderModuleId: null,
      rightExpanderModuleId: null,
    };
    // strict() rejects the extra legacy keys; modelName/gridPosition also differ.
    expect(ModuleSnapshot.safeParse(legacy).success).toBe(false);
  });

  it("rejects the old cable port field names (outputPortId/inputPortId)", () => {
    const { outputId: _o, inputId: _i, ...rest } = CABLE;
    const legacy = { ...rest, outputPortId: 0, inputPortId: 2 };
    expect(CableSnapshot.safeParse(legacy).success).toBe(false);
  });

  it("rejects the old root field names (bridgePresent/probeModuleIds/includesOpaqueState)", () => {
    const legacy = {
      ...SNAPSHOT,
      bridgePresent: true,
      probeModuleIds: [],
      includesOpaqueState: false,
    };
    expect(PatchSnapshot.safeParse(legacy).success).toBe(false);
  });

  it("rejects the old port connectedCableIds field", () => {
    const { connected: _c, ...rest } = OUTPUT_PORT;
    const legacy = { ...rest, connectedCableIds: ["100"] };
    expect(PortSnapshot.safeParse(legacy).success).toBe(false);
  });
});
