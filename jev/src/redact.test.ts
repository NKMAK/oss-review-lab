import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

const KEY = "test-key-not-real";

describe("redactSecrets(再帰的なマスク)", () => {
  it("文字列・配列・入れ子のオブジェクト・キー名のすべてから伏せる", () => {
    const v = { a: `x ${KEY} y`, list: [KEY, { deep: [`${KEY}!`] }], [`k-${KEY}`]: 1, n: 3, ok: null };
    const out = redactSecrets(v, KEY);
    expect(JSON.stringify(out).includes(KEY)).toBe(false);
    expect(out).toEqual({ a: "x [REDACTED] y", list: ["[REDACTED]", { deep: ["[REDACTED]!"] }], "k-[REDACTED]": 1, n: 3, ok: null });
  });

  it("エンコードされたキー(JSONエスケープ・URL・base64・base64url)も伏せる", () => {
    const key = 'test key/+="not-real';
    const enc = [
      JSON.stringify(key).slice(1, -1),
      encodeURIComponent(key),
      Buffer.from(key).toString("base64"),
      Buffer.from(key).toString("base64url"),
    ];
    for (const e of enc) {
      const out = JSON.stringify(redactSecrets({ m: `before ${e} after`, arr: [[e]] }, key));
      expect(out.includes(e)).toBe(false);
      expect(out.includes("[REDACTED]")).toBe(true);
    }
  });

  it("同じオブジェクトを複数の場所から参照していても(循環ではない)、そのまま残す。本当の循環だけを止める", () => {
    const shared = { model: "jev-1.13.0", usage: { input_tokens: 1 } };
    const out = redactSecrets({ results: [{ raw: shared }, { raw: shared }] }, KEY);
    expect(out).toEqual({ results: [{ raw: shared }, { raw: shared }] });
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(JSON.stringify(redactSecrets(loop, KEY))).toBe('{"a":1,"self":"[REDACTED]"}');
  });

  it("空のキーは何もしない。循環参照でも止まらない", () => {
    expect(redactSecrets({ a: "x" }, "")).toEqual({ a: "x" });
    const c: Record<string, unknown> = { s: KEY };
    c.self = c;
    expect(() => redactSecrets(c, KEY)).not.toThrow();
  });
});
