import { IS_ACK_ID } from "@oss-review-lab/shared";
import type { Result, Run } from "@oss-review-lab/shared";

/** 観点・言い方の判定に使う variant(URLの `variant`)。is_ack は、常に `reply`。 */
export type LabelVariant = "parent-only" | "with-replies";
export const LABEL_VARIANTS: readonly LabelVariant[] = ["parent-only", "with-replies"];
export const DEFAULT_LABEL_VARIANT: LabelVariant = "parent-only";

const REPLY_VARIANT = "reply";

function newestLast(a: Run, b: Run): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

/**
 * 完了(complete)した全てのrunの結果を、`(targetId, questionId, variant)` で合成する。
 * 同じ組み合わせが複数のrunにあれば、新しいrun(createdAt)を優先する(エラーの結果も、新しいものとして置き換える)。
 * partial・failed のrunは使わない。runの並びには依存しない。
 */
export function composeResults(runs: readonly Run[]): Result[] {
  const merged = new Map<string, Result>();
  for (const run of [...runs].filter((r) => r.status === "complete").sort(newestLast)) {
    for (const r of run.results) {
      merged.set(JSON.stringify([r.targetId, r.questionId, r.variant]), r);
    }
  }
  return Array.from(merged.values());
}

/**
 * 画面が使う結果を、合成した結果から選ぶ。
 * is_ack は variant: reply、観点・言い方は選んだ variant(parent-only / with-replies)。
 */
export function selectViewResults(results: readonly Result[], variant: LabelVariant): Result[] {
  return results.filter((r) => r.variant === (r.questionId === IS_ACK_ID ? REPLY_VARIANT : variant));
}
