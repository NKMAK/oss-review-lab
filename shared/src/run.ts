import { z } from "zod";
import { IsoUtcSchema } from "./thread";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const ProbabilitySchema = z.number().min(0).max(1); // NaN・Infinityはzodが拒否する
const VariantSchema = z.enum(["parent-only", "with-replies", "reply"]);
const RunStatusSchema = z.enum(["complete", "partial", "failed"]);

export const ResultSchema = z.object({
  targetId: z.string(),
  questionId: z.string(),
  questionType: z.enum(["noul", "choice", "score"]),
  questionDefHash: Sha256Schema,
  stateHash: Sha256Schema,
  variant: VariantSchema,
  /** APIの生の応答(監査用) */
  raw: z.unknown(),
  probability: ProbabilitySchema.nullable(),
  confidence: ProbabilitySchema.nullable(),
  latencyMs: z.number().min(0),
  usage: z
    .object({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
    })
    .nullable(),
  cost: z.number().min(0).nullable(),
  error: z
    .object({
      /** retryable: 429/529で再試行を尽くした。fatal: 4xxや契約違反。unknown: 応答不明(タイムアウト・通信エラー・5xx。課金された可能性があり、自動では再送しない) */
      kind: z.enum(["retryable", "fatal", "unknown"]),
      message: z.string(),
      attempts: z.number().int().min(0),
      stopReason: z.string().optional(),
    })
    .nullable(),
});
export type Result = z.infer<typeof ResultSchema>;

export const RunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  /** 応答の実際のモデル識別子 */
  model: z.string(),
  variant: VariantSchema,
  /** with-repliesの閾値 */
  stateConfig: z.object({ replyIsAckThreshold: ProbabilitySchema.optional() }),
  threadsSha256: Sha256Schema,
  questionPlanHash: Sha256Schema,
  questionDefs: z.array(z.object({ id: z.string(), hash: Sha256Schema })),
  createdAt: IsoUtcSchema,
  finishedAt: IsoUtcSchema.nullable(),
  status: RunStatusSchema,
  results: z.array(ResultSchema),
});
export type Run = z.infer<typeof RunSchema>;

/** data/ 配下の相対パスだけを許可する(絶対パス・URL・..・空セグメント・バックスラッシュ・ドライブ文字は拒否)。 */
export const DataRelativePathSchema = z.string().refine(
  (p) => {
    if (p === "" || p.startsWith("/") || p.includes("\\") || p.includes(":")) return false;
    return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
  },
  { message: "data/ 配下の相対パスだけを許可します(.. ・絶対パス・URLは不可)" },
);

/** 発見用の目録。来歴の正は Run 自身。 */
export const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.array(
    z.object({
      file: DataRelativePathSchema,
      sha256: Sha256Schema,
      repo: z.string(),
      fetchedAt: IsoUtcSchema,
    }),
  ),
  threads: z.object({
    file: DataRelativePathSchema,
    sha256: Sha256Schema,
    count: z.number().int().min(0),
  }),
  runs: z.array(
    z.object({
      runId: z.string(),
      status: RunStatusSchema,
      file: DataRelativePathSchema,
      sha256: Sha256Schema,
      createdAt: IsoUtcSchema,
      variant: VariantSchema,
    }),
  ),
});
export type Manifest = z.infer<typeof ManifestSchema>;
