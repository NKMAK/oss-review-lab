import { z } from "zod";
// shared/package.json に main/exports が無く、パッケージ名では型を解決できないため、型のみ相対で参照する(実行時には消える)。
import type { Result } from "@oss-review-lab/shared";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

export type JevQuestionType = "noul" | "choice" | "score";

export type JevQuestion = {
  id: string;
  type: JevQuestionType;
  instructions: string;
  criteria?: Record<string, unknown>;
};

export type JevFetch = (url: string, init: RequestInit) => Promise<Response>;

export type JevCallMeta = {
  targetId: string;
  stateHash: string;
  variant: Result["variant"];
  /** 質問ID -> 質問定義のhash */
  questionDefHashes: Record<string, string>;
};

export type JevCallInput = {
  state: unknown;
  questions: JevQuestion[];
  /** 例: "jev-latest" */
  model: string;
  /** 読み込みは呼び出し側。ログ・エラー・結果には出さない。 */
  apiKey: string;
  meta: JevCallMeta;
  fetch?: JevFetch;
  /** バックオフの待機(テストで待たないよう注入可能) */
  sleep?: (ms: number) => Promise<void>;
  /** 0以上1未満(ジッター用) */
  random?: () => number;
  /** ミリ秒の現在時刻(latency計測用) */
  now?: () => number;
  timeoutMs?: number;
};

export type JevCallOutcome = {
  /** 応答に含まれる実際のモデル識別子。得られなかったら null */
  model: string | null;
  /** 質問ごとに1件(入力の質問の順)。cost は常に null(計算はcost.ts) */
  results: Result[];
};

const Prob = z.number().min(0).max(1);
const AnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: Prob }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), Prob),
    confidence: Prob,
  }),
  z.object({
    type: z.literal("score"),
    score: z.union([z.string(), z.number()]),
    legend: z.record(z.string(), z.unknown()),
    probabilities: z.record(z.string(), Prob),
    confidence: Prob,
  }),
]);
const TokenCount = z.number().int().min(0);
const ResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), AnswerSchema),
  usage: z.object({ input_tokens: TokenCount, output_tokens: TokenCount }),
});

type Attempt =
  | { ok: true; text: string }
  | { ok: false; retryable: boolean; message: string; raw: unknown };

function redact(text: string, apiKey: string): string {
  return apiKey === "" ? text : text.split(apiKey).join("[REDACTED]");
}

async function attemptOnce(
  req: JevCallInput,
  body: string,
  fetchImpl: JevFetch,
  timeoutMs: number,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(JEV_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.apiKey}` },
      body,
      signal: controller.signal,
    });
    const text = redact(await res.text(), req.apiKey);
    if (res.status >= 200 && res.status < 300) return { ok: true, text };
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    return { ok: false, retryable, message: `HTTP ${res.status}: ${text}`, raw: text };
  } catch (e) {
    if (controller.signal.aborted) {
      return { ok: false, retryable: true, message: `timeout after ${timeoutMs}ms`, raw: null };
    }
    const msg = redact(e instanceof Error ? e.message : String(e), req.apiKey);
    return { ok: false, retryable: true, message: `network error: ${msg}`, raw: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Jev API を1回呼び(再試行込み)、質問ごとの Result に投影する。
 * 応答が契約に合わない場合は、リクエスト全体を fatal にする(raw は残す)。
 */
export async function callJev(req: JevCallInput): Promise<JevCallOutcome> {
  const ids = new Set<string>();
  for (const q of req.questions) {
    if (ids.has(q.id)) throw new Error(`duplicate question id: ${q.id}`);
    ids.add(q.id);
  }
  const fetchImpl = req.fetch ?? ((url, init) => fetch(url, init));
  const sleep = req.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = req.random ?? Math.random;
  const now = req.now ?? Date.now;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const body = JSON.stringify({
    state: req.state,
    model: req.model,
    questions: Object.fromEntries(
      req.questions.map((q) => [q.id, { type: q.type, instructions: q.instructions, criteria: q.criteria }]),
    ),
  });

  const start = now();
  let last: Attempt | undefined;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    last = await attemptOnce(req, body, fetchImpl, timeoutMs);
    if (last.ok || !last.retryable) break;
    if (attempts < MAX_ATTEMPTS) {
      const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
      await sleep(Math.round(base * (0.5 + random())));
    }
  }
  const latencyMs = now() - start;
  const attempt = last!;

  const base = (q: JevQuestion) => ({
    targetId: req.meta.targetId,
    questionId: q.id,
    questionType: q.type,
    questionDefHash: req.meta.questionDefHashes[q.id]!,
    stateHash: req.meta.stateHash,
    variant: req.meta.variant,
    latencyMs,
    cost: null,
  });
  const failAll = (
    kind: "retryable" | "fatal",
    message: string,
    raw: unknown,
    model: string | null,
  ): JevCallOutcome => ({
    model,
    results: req.questions.map((q) => ({
      ...base(q),
      raw,
      probability: null,
      confidence: null,
      usage: null,
      error: { kind, message, attempts },
    })),
  });

  if (!attempt.ok) {
    return failAll(attempt.retryable ? "retryable" : "fatal", attempt.message, attempt.raw, null);
  }

  let json: unknown;
  try {
    json = JSON.parse(attempt.text);
  } catch {
    return failAll("fatal", "response is not valid JSON", attempt.text, null);
  }
  const modelId =
    typeof json === "object" && json !== null && typeof (json as { model?: unknown }).model === "string"
      ? (json as { model: string }).model
      : null;

  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return failAll("fatal", `invalid response: ${issue.path.join(".")}: ${issue.message}`, json, modelId);
  }
  const { answers, usage } = parsed.data;
  const sent = new Set(req.questions.map((q) => q.id));
  const missing = req.questions.filter((q) => !(q.id in answers)).map((q) => q.id);
  const extra = Object.keys(answers).filter((k) => !sent.has(k));
  if (missing.length > 0 || extra.length > 0) {
    return failAll(
      "fatal",
      `question ids mismatch: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`,
      json,
      modelId,
    );
  }
  const mismatch = req.questions.find((q) => answers[q.id]!.type !== q.type);
  if (mismatch) {
    return failAll(
      "fatal",
      `answer type mismatch for ${mismatch.id}: sent ${mismatch.type}, got ${answers[mismatch.id]!.type}`,
      json,
      modelId,
    );
  }

  return {
    model: parsed.data.model,
    results: req.questions.map((q) => {
      const a = answers[q.id]!;
      return {
        ...base(q),
        raw: json,
        probability: a.type === "noul" ? a.noul : null,
        confidence: a.type === "noul" ? null : a.confidence,
        usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
        error: null,
      };
    }),
  };
}
