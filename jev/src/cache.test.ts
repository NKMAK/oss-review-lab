import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Result } from "@oss-review-lab/shared";
import { cacheKey, canonicalJson, contentHash, ResultCache } from "./cache";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

const result: Result = {
  targetId: "1",
  questionId: "is_ack",
  questionType: "noul",
  questionDefHash: H1,
  stateHash: H2,
  variant: "reply",
  raw: { type: "noul", noul: 0.9 },
  probability: 0.9,
  confidence: null,
  latencyMs: 120,
  usage: { inputTokens: 100, outputTokens: 10 },
  cost: 0.0001,
  error: null,
};

let dir: string;
let cache: ResultCache;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cache-"));
  cache = new ResultCache(join(dir, "cache"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("contentHash", () => {
  it("キーの順序が違っても同じ", () => {
    expect(contentHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(contentHash({ b: { d: [1, 2], c: 2 }, a: 1 }));
  });
  it("本文を1文字変えると変わる", () => {
    expect(contentHash({ reply: { body: "LGTM" } })).not.toBe(contentHash({ reply: { body: "LGTM!" } }));
  });
  it("undefinedのキーは無視し、有限でない数値は拒否する", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow("有限でない数値はハッシュできません");
  });
});

describe("cacheKey", () => {
  const base = { stateHash: H2, questionDefHash: H1, model: "jev-1.13.0" };
  it("同じ部品なら同じキー", () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
  });
  it("state・質問定義・モデルのどれが変わっても別のキー", () => {
    const keys = new Set([
      cacheKey(base),
      cacheKey({ ...base, stateHash: "c".repeat(64) }),
      cacheKey({ ...base, questionDefHash: "c".repeat(64) }),
      cacheKey({ ...base, model: "jev-1.14.0" }),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe("ResultCache", () => {
  const parts = { stateHash: H2, questionDefHash: H1, model: "jev-1.13.0" };

  it("未保存なら null", async () => {
    expect(await cache.get(parts)).toBe(null);
  });

  it("保存した結果が、そのまま返る(data/cache/<sha256>.json)", async () => {
    await cache.put("jev-1.13.0", result);
    expect(await cache.get(parts)).toEqual(result);
    expect(await readdir(join(dir, "cache"))).toEqual([`${cacheKey(parts)}.json`]);
  });

  it("本文だけ変えた(stateHashが違う)入力は、ヒットしない", async () => {
    await cache.put("jev-1.13.0", result);
    expect(await cache.get({ ...parts, stateHash: contentHash({ reply: { body: "changed" } }) })).toBe(null);
  });

  it("質問定義が変わる、またはモデルが変わると、ヒットしない", async () => {
    await cache.put("jev-1.13.0", result);
    expect(await cache.get({ ...parts, questionDefHash: "c".repeat(64) })).toBe(null);
    expect(await cache.get({ ...parts, model: "jev-1.14.0" })).toBe(null);
  });

  it("errorつきの結果は保存しない", async () => {
    await expect(
      cache.put("jev-1.13.0", { ...result, error: { kind: "fatal", message: "x", attempts: 1 } }),
    ).rejects.toThrow("errorつきの結果はキャッシュしません");
    expect(await cache.get(parts)).toBe(null);
  });

  it("壊れたキャッシュは、ファイル名付きで止める", async () => {
    await cache.put("jev-1.13.0", result);
    const file = join(dir, "cache", `${cacheKey(parts)}.json`);
    await writeFile(file, "{broken");
    await expect(cache.get(parts)).rejects.toThrow(`${file}: キャッシュがJSONとして読めません`);
    await writeFile(file, '{"schemaVersion":1}');
    await expect(cache.get(parts)).rejects.toThrow(`${file}: キャッシュの形式が不正です`);
  });
});
