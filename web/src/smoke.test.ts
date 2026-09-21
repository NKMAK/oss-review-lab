import { describe, expect, it } from "vitest";

describe("web smoke", () => {
  it("Vitestがjsdom環境で動く", () => {
    expect(typeof document.createElement("div").tagName).toBe("string");
    expect(document.createElement("div").tagName).toBe("DIV");
  });
});
