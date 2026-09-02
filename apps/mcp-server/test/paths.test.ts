import { describe, expect, it } from "vitest";
import { sep } from "node:path";
import { isReservedWindowsName, isUrl, within } from "../src/paths.js";

describe("path policy helpers", () => {
  it("rejects URLs but not Windows drive paths with doubled slashes", () => {
    expect(isUrl("https://example.com/a.vcv")).toBe(true);
    expect(isUrl("file:///tmp/a.vcv")).toBe(true);
    expect(isUrl("FILE:///tmp/a.vcv")).toBe(true);
    expect(isUrl("smb://host/share/a.vcv")).toBe(true);
    expect(isUrl("C://Users/x/a.vcv")).toBe(false);
    expect(isUrl("C:\\Users\\x\\a.vcv")).toBe(false);
    expect(isUrl("/tmp/a.vcv")).toBe(false);
  });

  it("flags reserved Windows device names regardless of extension or case", () => {
    for (const n of ["nul.vcv", "NUL", "con.vcv", "Com1.vcv", "lpt9.vcv", "aux", "prn.VCV"]) {
      expect(isReservedWindowsName(n), n).toBe(true);
    }
    for (const n of ["null.vcv", "console.vcv", "com0.vcv", "com10.vcv", "lpt.vcv", "patch.vcv"]) {
      expect(isReservedWindowsName(n), n).toBe(false);
    }
    expect(isReservedWindowsName("trailing.vcv.")).toBe(true);
    expect(isReservedWindowsName("trailing ")).toBe(true);
  });

  it("containment needs a separator boundary and honours case sensitivity", () => {
    const root = ["", "r", "patches"].join(sep);
    const under = [root, "a.vcv"].join(sep);
    expect(within(root, root, false)).toBe(true);
    expect(within(root, under, false)).toBe(true);
    expect(within(root, root + "-evil" + sep + "a.vcv", false)).toBe(false);
    expect(within(root, under.toUpperCase(), false)).toBe(false);
    expect(within(root, under.toUpperCase(), true)).toBe(true);
  });
});
