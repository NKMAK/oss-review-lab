import { z } from "zod";
// shared/package.json に main/exports が無く、パッケージ名では型を解決できないため、型のみ相対で参照する(実行時には消える)。
import type { Result } from "@oss-review-lab/shared";
import { redactSecrets } from "./redact";

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

/**
 * 1回の試行の結果。エラー本文は、(stateのエコーを含み得るので)保持しない。状態コードと固定のコードだけ。
 * - retry: 429/529。再送してよい(処理・課金は済んでいない)
 * - unknown: 応答不明(タイムアウト・通信エラー・その他の5xx・本文の読み取り失敗)。冪等キーが無いので、再送しない
 * - fatal: 4xx。再送しない(課金なし)
 */
type Attempt =
  | { ok: true; text: string }
  | { ok: false; outcome: "retry" | "unknown" | "fatal"; message: string };

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
    if (res.status >= 200 && res.status < 300) {
      // 本文の読み取りも、タイムアウトの対象(切断されたら、処理は済んでいる可能性があるので応答不明)
      return { ok: true, text: await res.text() };
    }
    // エラー本文は読まない(保存もしない)
    void res.body?.cancel().catch(() => undefined);
    const message = `HTTP ${res.status}`;
    if (res.status === 429 || res.status === 529) return { ok: false, outcome: "retry", message };
    if (res.status >= 500) return { ok: false, outcome: "unknown", message };
    return { ok: false, outcome: "fatal", message };
  } catch {
    // 例外の中身(キーやURLを含み得る)は使わない
    return { ok: false, outcome: "unknown", message: controller.signal.aborted ? "timeout" : "network error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 保存してよい応答の許可リスト。`model`・`usage`・noulの確率だけを残す。
 * 説明文・エコーされたstate・未知のフィールドは落とす(他人のコメント本文を保存物に残さない)。
 * 契約に合わない値は、null(保存しない)。
 */
export function pickAllowedRaw(json: unknown): unknown {
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) return null;
  const { model, usage, answers } = parsed.data;
  return {
    model,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, a]) => {
        if (a.type === "noul") return [id, { type: "noul", noul: a.noul }];
        // choice/score の値・確率のキーは任意文字列なので、コメント本文が混ざり得る。このMVPでは使わない。
        return [id, { type: a.type }];
      }),
    ),
  };
}

/** 送信するリクエスト本文(JSON文字列)。予約額の見積もり(大きさ)も、これを使う。 */
export function buildRequestBody(state: unknown, model: string, questions: JevQuestion[]): string {
  return JSON.stringify({
    state,
    model,
    questions: Object.fromEntries(
      questions.map((q) => [q.id, { type: q.type, instructions: q.instructions, criteria: q.criteria }]),
    ),
  });
}

/**
 * Jev API を1回呼び、質問ごとの Result に投影する。
 * 自動で再送するのは 429・529 だけ(最大 MAX_ATTEMPTS 回)。タイムアウト・通信エラー・その他の5xxは、
 * 課金済みかもしれず冪等キーも無いので、再送せず error.kind: "unknown" を返す。
 * 応答が契約に合わない場合は、リクエスト全体を fatal にする(応答は保存しない)。
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

  const body = buildRequestBody(req.state, req.model, req.questions);

  const start = now();
  let last: Attempt | undefined;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    last = await attemptOnce(req, body, fetchImpl, timeoutMs);
    if (last.ok || last.outcome !== "retry") break;
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
  // 保存物に載るものは、最後に必ずキーのマスクを通す(応答・例外・入れ子のJSONを再帰的に)
  const finish = (outcome: JevCallOutcome): JevCallOutcome => redactSecrets(outcome, req.apiKey);
  const failAll = (kind: "retryable" | "fatal" | "unknown", message: string, model: string | null): JevCallOutcome =>
    finish({
      model,
      results: req.questions.map((q) => ({
        ...base(q),
        raw: null,
        probability: null,
        confidence: null,
        usage: null,
        error: { kind, message, attempts },
      })),
    });

  if (!attempt.ok) {
    return failAll(attempt.outcome === "retry" ? "retryable" : attempt.outcome, attempt.message, null);
  }

  let json: unknown;
  try {
    json = JSON.parse(attempt.text);
  } catch {
    return failAll("fatal", "response is not valid JSON", null);
  }
  const modelId =
    typeof json === "object" && json !== null && typeof (json as { model?: unknown }).model === "string"
      ? (json as { model: string }).model
      : null;

  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) {
    // zodの詳細(値を含み得る)は使わない
    return failAll("fatal", "invalid response: schema mismatch", modelId);
  }
  const { answers, usage } = parsed.data;
  const sent = new Set(req.questions.map((q) => q.id));
  const missing = req.questions.filter((q) => !(q.id in answers)).map((q) => q.id);
  const extra = Object.keys(answers).filter((k) => !sent.has(k));
  if (missing.length > 0 || extra.length > 0) {
    return failAll("fatal", `question ids mismatch: missing=[${missing.join(",")}] extra=${extra.length}`, modelId);
  }
  const mismatch = req.questions.find((q) => answers[q.id]!.type !== q.type);
  if (mismatch) {
    return failAll(
      "fatal",
      `answer type mismatch for ${mismatch.id}: sent ${mismatch.type}, got ${answers[mismatch.id]!.type}`,
      modelId,
    );
  }

  const raw = pickAllowedRaw(json);
  return finish({
    model: parsed.data.model,
    results: req.questions.map((q) => {
      const a = answers[q.id]!;
      return {
        ...base(q),
        raw,
        probability: a.type === "noul" ? a.noul : null,
        confidence: a.type === "noul" ? null : a.confidence,
        usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
        error: null,
      };
    }),
  });
}
