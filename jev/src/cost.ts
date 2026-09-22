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

/** 過去の出力トークンの実績(1質問あたりの最大)。まだ無い(初回)なら null を渡す。 */
export type OutputHistory = { maxOutputTokensPerQuestion: number };

/** 過去の最大に対する安全率。実費が予約額を超えたら overrun として検出する(最後の砦)。 */
export const OUTPUT_SAFETY_FACTOR = 2;

export const NEED_MAX_COST_MESSAGE =
  "使用量が未確認(または単価が未設定)のため、--max-cost-per-request が必須です(最初は --limit 1 --questions is_ack で試してください)";

/** サーバー側が質問をテンプレートに組み込む分(公式の例: 本文が短くても input_tokens は307)。本文のバイト数に、固定で足す。 */
export const REQUEST_OVERHEAD_TOKENS = 1000;
export const PER_QUESTION_OVERHEAD_TOKENS = 100;
/** 入力トークン数の見積もりにかける安全率 */
export const INPUT_SAFETY_FACTOR = 2;

/** 入力トークン数の見積もり(保守的な上限のつもり。実費を保証しない)。(本文のバイト数 + 固定オーバーヘッド) × 安全率。 */
export function estimateInputTokens(requestBody: string, questionCount: number): number {
  return (Buffer.byteLength(requestBody, "utf8") + REQUEST_OVERHEAD_TOKENS + PER_QUESTION_OVERHEAD_TOKENS * questionCount) * INPUT_SAFETY_FACTOR;
}

export type ReserveInput = {
  /** 送るリクエスト本文(JSON文字列)。この大きさ(UTF-8のバイト数)に固定オーバーヘッドと安全率を加えて、入力トークン数を見積もる */
  requestBody: string;
  /** このリクエストに含める質問の数 */
  questionCount: number;
  history: OutputHistory | null;
  pricing: Pricing | null;
  /** `--max-cost-per-request` */
  maxCostPerRequest?: number;
};

export type ReserveDecision = { ok: true; amount: number } | { ok: false; reason: string };

/**
 * 1リクエストの予約額(実費の上限にするつもりの見積もり。保証はしない)。
 * - 入力: (リクエスト本文のUTF-8バイト数 + 固定オーバーヘッド) × 安全率 を、入力トークン数とみなす(estimateInputTokens)。
 * - 出力: 過去の実績があれば、1質問あたりの最大 × 安全率 × 質問数。無ければ(初回)、`--max-cost-per-request` が必須で、その値を上限とする。
 * - `--max-cost-per-request` があるとき、上限を保証できない(入力費用や見積もりがそれを超える)なら、予約できない(送らない)。
 */
export function estimateReserve(input: ReserveInput): ReserveDecision {
  const { requestBody, questionCount, history, pricing, maxCostPerRequest } = input;
  if (maxCostPerRequest !== undefined && (!Number.isFinite(maxCostPerRequest) || maxCostPerRequest <= 0)) {
    throw new Error(`--max-cost-per-request は有限で正の数値にしてください: ${String(maxCostPerRequest)}`);
  }
  const inputCost = pricing === null ? null : estimateInputTokens(requestBody, questionCount) * pricing.inputUsdPerToken;

  if (history === null || pricing === null) {
    if (maxCostPerRequest === undefined) throw new Error(NEED_MAX_COST_MESSAGE);
    if (inputCost !== null && inputCost > maxCostPerRequest) {
      return {
        ok: false,
        reason: `リクエストの大きさから求めた入力費用(${inputCost})が --max-cost-per-request(${maxCostPerRequest})を超えるため、見積もりの上限を超えて送信しません`,
      };
    }
    return { ok: true, amount: maxCostPerRequest };
  }

  // 浮動小数点の誤差(20.000000000000004 など)で、1トークン余計に数えない
  const outputTokens = Math.max(1, Math.ceil(history.maxOutputTokensPerQuestion * OUTPUT_SAFETY_FACTOR - 1e-9)) * questionCount;
  const amount = (inputCost ?? 0) + outputTokens * pricing.outputUsdPerToken;
  if (maxCostPerRequest !== undefined && amount > maxCostPerRequest) {
    return {
      ok: false,
      reason: `見積もりの予約額(${amount})が --max-cost-per-request(${maxCostPerRequest})を超えるため、送信しません`,
    };
  }
  return { ok: true, amount };
}
