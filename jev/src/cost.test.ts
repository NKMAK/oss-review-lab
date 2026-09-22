import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPricingForMode,
  computeCost,
  estimateInputTokens,
  estimateReserve,
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
  // 公式(https://docs.typesafe.ai/models.md): 入力 $0.042/100万トークン、出力は無料
  return { schemaVersion: 1, inputUsdPerToken: 4.2e-8, outputUsdPerToken: 0 };
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

describe("estimateReserve(予約額は、実費の上限でなければならない)", () => {
  const body = (n: number) => JSON.stringify({ state: "x".repeat(n) });
  const bytes = (b: string) => Buffer.byteLength(b);
  // 入力 0.000002/token、出力 0.00001/token
  const history = { maxOutputTokensPerQuestion: 10 };

  it("初回(使用量が未確認)は --max-cost-per-request が必須", () => {
    expect(() => estimateReserve({ requestBody: body(10), questionCount: 1, history: null, pricing })).toThrow(
      "使用量が未確認(または単価が未設定)のため、--max-cost-per-request が必須です(最初は --limit 1 --questions is_ack で試してください)",
    );
  });
  it("単価が未設定でも --max-cost-per-request が必須", () => {
    expect(() => estimateReserve({ requestBody: body(10), questionCount: 1, history, pricing: null })).toThrow(
      "--max-cost-per-request が必須です",
    );
  });
  it("初回は、--max-cost-per-request の値を予約額にする(単価が無くても)", () => {
    expect(estimateReserve({ requestBody: body(10), questionCount: 1, history: null, pricing: null, maxCostPerRequest: 0.05 })).toEqual({
      ok: true,
      amount: 0.05,
    });
  });
  it("初回で、リクエストの大きさから求めた入力費用が --max-cost-per-request を超えるなら、予約できない(上限を保証できない)", () => {
    const b = body(100_000);
    const r = estimateReserve({ requestBody: b, questionCount: 1, history: null, pricing, maxCostPerRequest: 0.05 });
    expect(estimateInputTokens(b, 1) * pricing.inputUsdPerToken).toBeGreaterThan(0.05);
    expect(r.ok).toBe(false);
  });
  it("2回目以降は、入力(リクエストのバイト数を、トークン数の上限とする) + 出力(過去の最大 × 安全率2 × 質問数)で、大きい state ほど大きい予約額", () => {
    const small = estimateReserve({ requestBody: body(100), questionCount: 2, history, pricing });
    const large = estimateReserve({ requestBody: body(10_000), questionCount: 2, history, pricing });
    if (!small.ok || !large.ok) throw new Error("ok expected");
    expect(small.amount).toBeCloseTo(estimateInputTokens(body(100), 2) * 0.000002 + 10 * 2 * 2 * 0.00001, 12);
    expect(large.amount).toBeGreaterThan(small.amount);
    expect(large.amount - small.amount).toBeCloseTo((estimateInputTokens(body(10_000), 2) - estimateInputTokens(body(100), 2)) * 0.000002, 12);
  });
  it("入力トークン数は、本文のバイト数だけでなく、サーバー側のテンプレート分の固定オーバーヘッドと安全率2を加えた保守的な値", () => {
    // 公式の例: 本文が短くても(state 約45文字・質問1つ)、input_tokens は 307 だった。バイト数だけでは、下回り得る
    const b = body(45);
    expect(estimateInputTokens(b, 1)).toBe((bytes(b) + 1000 + 100) * 2);
    expect(estimateInputTokens(b, 1)).toBeGreaterThan(307);
    expect(estimateInputTokens(b, 15)).toBe((bytes(b) + 1000 + 100 * 15) * 2);
  });
  it("出力単価が0でも、予約額は入力の費用だけで決まる(出力の項は0)", () => {
    const free = { schemaVersion: 1 as const, inputUsdPerToken: 4.2e-8, outputUsdPerToken: 0 };
    const r = estimateReserve({ requestBody: body(45), questionCount: 1, history, pricing: free });
    expect(r).toEqual({ ok: true, amount: estimateInputTokens(body(45), 1) * 4.2e-8 });
    const bigOutput = estimateReserve({ requestBody: body(45), questionCount: 1, history: { maxOutputTokensPerQuestion: 100_000 }, pricing: free });
    expect(bigOutput).toEqual(r);
  });
  it("1質問あたりの出力トークン(安全率をかけた値)を、整数に切り上げてから、質問数を掛ける(平均の近似より、多めに見積もる)", () => {
    // 実績: 15問で出力10トークン → 1問あたり 0.667。× 安全率2 = 1.333 → 2トークンに切り上げ × 15問 = 30(まとめて切り上げると20)
    const r = estimateReserve({ requestBody: "", questionCount: 15, history: { maxOutputTokensPerQuestion: 10 / 15 }, pricing: { schemaVersion: 1, inputUsdPerToken: 0, outputUsdPerToken: 1 } });
    expect(r).toEqual({ ok: true, amount: 30 });
  });
  it("質問数が多いほど、出力の上限も大きい", () => {
    const one = estimateReserve({ requestBody: body(10), questionCount: 1, history, pricing });
    const fifteen = estimateReserve({ requestBody: body(10), questionCount: 15, history, pricing });
    if (!one.ok || !fifteen.ok) throw new Error("ok expected");
    expect(fifteen.amount).toBeGreaterThan(one.amount);
  });
  it("見積もりが --max-cost-per-request を超えるなら、予約できない(上限として働く)", () => {
    const r = estimateReserve({ requestBody: body(10), questionCount: 15, history, pricing, maxCostPerRequest: 0.0001 });
    expect(r.ok).toBe(false);
  });
  it.each([[0], [-1], [Number.NaN], [Infinity]])("--max-cost-per-request=%s を拒否する", (v) => {
    expect(() => estimateReserve({ requestBody: body(1), questionCount: 1, history: null, pricing, maxCostPerRequest: v })).toThrow(
      "--max-cost-per-request は有限で正の数値にしてください",
    );
  });
});
