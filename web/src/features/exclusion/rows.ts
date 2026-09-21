import { isCodeExcludedReply } from "@oss-review-lab/shared";
import type { Comment, Result, Thread } from "@oss-review-lab/shared";

export const IS_ACK_QUESTION_ID = "is_ack";

export type ExclusionRow = {
  reply: Comment;
  /** is_ack の確率(同意・完了報告である確率) */
  probability: number;
  /** 親コメント。取得範囲外などで無ければ null */
  parent: Comment | null;
  /** この返信より前の返信(時系列順) */
  priorReplies: Comment[];
  /** bot・不明ユーザーの返信(閾値に関わらず、コードで除外済み) */
  codeExcluded: boolean;
  prUrl: string | null;
};

/**
 * is_ack の結果から、除外の目視確認の行を作る(確率の降順、同じ確率はid順)。
 * 親コメントへの結果・確率が無い結果(エラー)・対象が見つからない結果は、行にしない。
 */
export function buildExclusionRows(threads: readonly Thread[], results: readonly Result[]): ExclusionRow[] {
  const replyIndex = new Map<string, { thread: Thread; index: number }>();
  for (const thread of threads) {
    thread.comments.forEach((c, index) => {
      if (c.role === "reply") replyIndex.set(c.id, { thread, index });
    });
  }

  const rows: ExclusionRow[] = [];
  for (const r of results) {
    if (r.questionId !== IS_ACK_QUESTION_ID || r.probability === null) continue;
    const found = replyIndex.get(r.targetId);
    if (found === undefined) continue;
    const { thread, index } = found;
    const reply = thread.comments[index] as Comment;
    rows.push({
      reply,
      probability: r.probability,
      parent: thread.comments.find((c) => c.role === "root") ?? null,
      priorReplies: thread.comments.slice(0, index).filter((c) => c.role === "reply"),
      codeExcluded: isCodeExcludedReply(reply),
      prUrl: thread.pr?.url ?? null,
    });
  }
  return rows.sort((a, b) => b.probability - a.probability || compareId(a.reply.id, b.reply.id));
}

function compareId(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
