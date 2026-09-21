import { readFile } from "node:fs/promises";
import { z } from "zod";

export const PricingSchema = z.object({
  schemaVersion: z.literal(1),
  /** 入力トークン1個あたりのドル */
  inputUsdPerToken: z.number().min(0),
  /** 出力トークン1個あたりのドル */
  outputUsdPerToken: z.number().min(0),
});
export type Pricing = z.infer<typeof PricingSchema>;

export type Usage = { inputTokens: number; outputTokens: number };

/**
 * jev/pricing.json を読む。ファイルが無ければ null(単価が未設定)。
 * 壊れていれば、ファイル名付きのエラーで止める。
 */
export async function loadPricing(path: string): Promise<Pricing | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: JSONとして読めません: ${(e as Error).message}`);
  }
  const parsed = PricingSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${path}: 単価の形式が不正です: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** 費用 = input_tokens × 入力単価 + output_tokens × 出力単価 */
export function computeCost(usage: Usage, pricing: Pricing): number {
  return usage.inputTokens * pricing.inputUsdPerToken + usage.outputTokens * pricing.outputUsdPerToken;
}

/** `--observed-cost` の検証(有限・非負)。文字列も受け付ける。 */
export function parseObservedCost(value: number | string): number {
  const n = typeof value === "string" ? (value.trim() === "" ? Number.NaN : Number(value)) : value;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--observed-cost は有限で非負の数値にしてください: ${String(value)}`);
  }
  return n;
}

export type RunMode = "dry-run" | "limit" | "all";

/** 単価が未設定なら、`--limit` の試走と dry-run 以外(全件)を拒否する。 */
export function assertPricingForMode(mode: RunMode, pricing: Pricing | null): void {
  if (pricing === null && mode === "all") {
    throw new Error(
      "単価が未設定です(jev/pricing.json)。--limit の試走以外は実行できません。pricing.example.json を参考に作成してください",
    );
  }
}

export type ReserveAmountInput = {
  /** `--max-cost-per-request` */
  maxCostPerRequest?: number;
  /** 直近のrunの平均使用量。まだ無ければ null(初回) */
  averageUsage: Usage | null;
  pricing: Pricing | null;
};

/**
 * 1リクエストあたりの予約額を決める。
 * - `--max-cost-per-request` があれば、それを使う(保守的な上限)。
 * - 無ければ、直近のrunの平均トークン × 単価。使用量が未確認(初回)か単価が未設定なら、必須として拒否する。
 */
export function decideReserveAmount(input: ReserveAmountInput): number {
  const { maxCostPerRequest, averageUsage, pricing } = input;
  if (maxCostPerRequest !== undefined) {
    if (!Number.isFinite(maxCostPerRequest) || maxCostPerRequest <= 0) {
      throw new Error(`--max-cost-per-request は有限で正の数値にしてください: ${String(maxCostPerRequest)}`);
    }
    return maxCostPerRequest;
  }
  if (averageUsage === null || pricing === null) {
    throw new Error(
      "使用量が未確認(または単価が未設定)のため、--max-cost-per-request が必須です(最初は --limit 1 --questions is_ack で試してください)",
    );
  }
  return computeCost(averageUsage, pricing);
}
