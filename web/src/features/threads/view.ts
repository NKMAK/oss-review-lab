import { IS_ACK_ID, deriveLabels, isAckExcluded, isCodeExcludedReply } from "@oss-review-lab/shared";
import type { Comment, DerivedLabels, Result, Thread } from "@oss-review-lab/shared";
import type { ViewParams } from "../../params/params";

export type ExcludedReplyReason = "ack" | "bot" | "unknown";

export type ThreadView = {
  thread: Thread;
  /** 親コメント。親が取得範囲外のスレッド(parent-missing)では null */
  root: Comment | null;
  /** この親の観点・言い方の結果があるか(無ければ未判定) */
  judged: boolean;
  /** 閾値以上のラベル(未判定なら空。届かなければ「その他」) */
  labels: DerivedLabels;
  /** 質問ID → 確率(エラーの質問は含めない) */
  probabilities: Record<string, number>;
  /** 除外される返信(is_ackが閾値以上、bot、削除済みユーザー) */
  excludedReplies: { id: string; reason: ExcludedReplyReason }[];
};

/** 2つの閾値: 観点・言い方のラベルと、返信の除外(is_ack)は、意味が違うので別。 */
export type Thresholds = { labelThreshold: number; ackThreshold: number };

/** 1スレッドの、Jevの結果に基づく表示用の導出。 */
export function buildThreadView(thread: Thread, results: readonly Result[], thresholds: Thresholds): ThreadView {
  const rootResults = results.filter((r) => r.targetId === thread.threadId && r.questionId !== IS_ACK_ID);
  const judged = rootResults.length > 0;
  const probabilities: Record<string, number> = {};
  for (const r of rootResults) {
    if (r.probability !== null) probabilities[r.questionId] = r.probability;
  }

  const excludedReplies: ThreadView["excludedReplies"] = [];
  for (const c of thread.comments) {
    if (c.role !== "reply") continue;
    if (isCodeExcludedReply(c)) {
      excludedReplies.push({ id: c.id, reason: c.authorKind === "bot" ? "bot" : "unknown" });
      continue;
    }
    const ack = results.find((r) => r.targetId === c.id && r.questionId === IS_ACK_ID);
    if (ack !== undefined && ack.probability !== null && isAckExcluded(ack.probability, thresholds.ackThreshold)) {
      excludedReplies.push({ id: c.id, reason: "ack" });
    }
  }

  return {
    thread,
    root: thread.comments.find((c) => c.role === "root") ?? null,
    judged,
    labels: judged ? deriveLabels(rootResults, thresholds.labelThreshold) : { aspects: [], styles: [] },
    probabilities,
    excludedReplies,
  };
}

/**
 * 絞り込み。観点・言い方は、選んだもののいずれかを含む(OR)。観点と言い方と発言者役割は AND。
 * 発言者役割は親コメントの発言者で判定し、不明(null)は「全員」以外に入れない。
 */
export function filterThreadViews(views: readonly ThreadView[], params: ViewParams): ThreadView[] {
  return views.filter((v) => {
    if (!params.showExcluded && v.thread.excludedReason !== null) return false;
    if (params.aspects.length > 0 && !v.labels.aspects.some((a) => params.aspects.includes(a))) return false;
    if (params.styles.length > 0 && !v.labels.styles.some((s) => params.styles.includes(s))) return false;
    if (params.role !== "all") {
      const isAuthor = v.root?.isPrAuthor ?? null;
      if (isAuthor === null) return false;
      if ((params.role === "pr-author") !== isAuthor) return false;
    }
    return true;
  });
}
