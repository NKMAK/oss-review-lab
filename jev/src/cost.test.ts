import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPricingForMode,
  computeCost,
  decideReserveAmount,
  loadPricing,
  parseObservedCost,
} from "./cost";

const pricing = { schemaVersion: 1 as const, inputUsdPerToken: 0.000002, outputUsdPerToken: 0.00001 };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cost-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("computeCost", () => {
  it("入力・出力トークンに、それぞれの単価を掛けて足す", () => {
    expect(computeCost({ inputTokens: 1000, outputTokens: 100 }, pricing)).toBe(0.003);
  });
});

describe("loadPricing", () => {
  it("ファイルが無ければ null(未設定)", async () => {
    expect(await loadPricing(join(dir, "pricing.json"))).toBe(null);
  });

  it("正しいファイルを読める", async () => {
    await writeFile(join(dir, "pricing.json"), JSON.stringify(pricing));
    expect(await loadPricing(join(dir, "pricing.json"))).toEqual(pricing);
  });

  it("負の単価は、ファイル名付きで拒否する", async () => {
    const p = join(dir, "pricing.json");
    await writeFile(p, JSON.stringify({ ...pricing, inputUsdPerToken: -1 }));
    await expect(loadPricing(p)).rejects.toThrow(`${p}: 単価の形式が不正です`);
  });

  it("壊れたJSONは、ファイル名付きで拒否する", async () => {
    const p = join(dir, "pricing.json");
    await writeFile(p, "{oops");
    await expect(loadPricing(p)).rejects.toThrow(`${p}: JSONとして読めません`);
  });

  it("コミットする pricing.example.json が、スキーマに合う", async () => {
    const example = join(import.meta.dirname, "..", "pricing.example.json");
    expect(await loadPricing(example)).toEqual(pricing2());
  });
});

function pricing2() {
  return { schemaVersion: 1, inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000001 };
}

describe("assertPricingForMode(単価が未設定のとき)", () => {
  it("全件を拒否する", () => {
    expect(() => assertPricingForMode("all", null)).toThrow(
      "単価が未設定です(jev/pricing.json)。--limit の試走以外は実行できません。pricing.example.json を参考に作成してください",
    );
  });
  it("--limit の試走と dry-run は通す", () => {
    expect(assertPricingForMode("limit", null)).toBe(undefined);
    expect(assertPricingForMode("dry-run", null)).toBe(undefined);
  });
  it("単価があれば、全件も通す", () => {
    expect(assertPricingForMode("all", pricing)).toBe(undefined);
  });
});

describe("parseObservedCost", () => {
  it("有限で非負の数値を受け付ける(文字列も)", () => {
    expect(parseObservedCost(0)).toBe(0);
    expect(parseObservedCost("0.25")).toBe(0.25);
  });
  it.each([[-0.01], [Number.NaN], [Infinity], [-Infinity], ["abc"], [""], ["-1"]])("%s を拒否する", (v) => {
    expect(() => parseObservedCost(v)).toThrow("--observed-cost は有限で非負の数値にしてください");
  });
});

describe("decideReserveAmount", () => {
  it("初回(使用量が未確認)は --max-cost-per-request が必須", () => {
    expect(() => decideReserveAmount({ averageUsage: null, pricing })).toThrow(
      "使用量が未確認(または単価が未設定)のため、--max-cost-per-request が必須です(最初は --limit 1 --questions is_ack で試してください)",
    );
  });
  it("単価が未設定でも --max-cost-per-request が必須", () => {
    expect(() => decideReserveAmount({ averageUsage: { inputTokens: 1, outputTokens: 1 }, pricing: null })).toThrow(
      "--max-cost-per-request が必須です",
    );
  });
  it("--max-cost-per-request があれば、その値を予約額にする", () => {
    expect(decideReserveAmount({ maxCostPerRequest: 0.05, averageUsage: null, pricing: null })).toBe(0.05);
  });
  it("2回目以降は、平均トークン × 単価で見積もる", () => {
    expect(decideReserveAmount({ averageUsage: { inputTokens: 1000, outputTokens: 100 }, pricing })).toBe(0.003);
  });
  it.each([[0], [-1], [Number.NaN], [Infinity]])("--max-cost-per-request=%s を拒否する", (v) => {
    expect(() => decideReserveAmount({ maxCostPerRequest: v, averageUsage: null, pricing })).toThrow(
      "--max-cost-per-request は有限で正の数値にしてください",
    );
  });
});
