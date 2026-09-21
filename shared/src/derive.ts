import { ASPECT_IDS, OTHER_LABEL, STYLE_IDS } from "./questions";
import type { AspectId, OtherLabel, StyleId } from "./questions";
import type { Result } from "./run";
import type { Comment } from "./thread";

/** 浮動小数点の誤差(例: 0.8 - 0.7)で境界がずれないための許容幅。 */
const EPSILON = 1e-9;

/** bot・unknown(削除済みユーザー)の返信は、保存せず、authorKindから都度導いて除外する。 */
export function isCodeExcludedReply(comment: Comment): boolean {
  return comment.authorKind === "bot" || comment.authorKind === "unknown";
}

/** is_ack の確率が閾値以上なら、返信を除外する。 */
export function isAckExcluded(prob: number, threshold: number): boolean {
  return prob >= threshold;
}

/** 「要確認」の帯: threshold ± width(境界を含む)。 */
export function isReviewBand(prob: number, threshold: number, width: number): boolean {
  return Math.abs(prob - threshold) <= width + EPSILON;
}

export type DerivedLabels = {
  aspects: (AspectId | OtherLabel)[];
  styles: (StyleId | OtherLabel)[];
};

/**
 * 1つの親コメントの結果から、閾値以上の観点・言い方を導く(定義順)。
 * どれも届かなければ「その他」(other)。エラー(確率null)は無視する。
 */
export function deriveLabels(results: readonly Result[], threshold: number): DerivedLabels {
  const passed = new Set<string>();
  for (const r of results) {
    if (r.probability !== null && r.probability >= threshold) passed.add(r.questionId);
  }
  const aspects: DerivedLabels["aspects"] = ASPECT_IDS.filter((id) => passed.has(id));
  const styles: DerivedLabels["styles"] = STYLE_IDS.filter((id) => passed.has(id));
  return {
    aspects: aspects.length > 0 ? aspects : [OTHER_LABEL],
    styles: styles.length > 0 ? styles : [OTHER_LABEL],
  };
}
