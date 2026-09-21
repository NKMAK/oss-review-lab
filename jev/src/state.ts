import { createHash } from "node:crypto";
import { isAckExcluded, isCodeExcludedReply } from "@oss-review-lab/shared";
import type { Comment, Thread } from "@oss-review-lab/shared";

/** キー順に依存しない決定的なJSON文字列(hash計算用)。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const entries = Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 対象の選定: excludedReasonがnullで、親のauthorKindがhumanのスレッド。 */
export function selectTargetThreads(threads: readonly Thread[]): Thread[] {
  return threads.filter((t) => {
    if (t.excludedReason !== null) return false;
    const root = t.comments.find((c) => c.role === "root");
    return root !== undefined && root.authorKind === "human";
  });
}

/** is_ackの対象: bot・unknownを除く返信(親は含まない)。 */
export function selectAckTargets(thread: Thread): Comment[] {
  return thread.comments.filter((c) => c.role === "reply" && !isCodeExcludedReply(c));
}

export type ParentOnlyState = {
  comment: { body: string; path: string };
  diffHunk: string;
  pr: { title: string } | null;
};
export type WithRepliesState = ParentOnlyState & { replies: { body: string }[] };
export type IsAckState = {
  thread: {
    root: { body: string; path: string };
    earlier: { role: "root" | "reply"; body: string }[];
  };
  reply: { body: string };
};

export type Built<S> = { state: S; stateHash: string };

function rootOf(thread: Thread): Comment {
  const root = thread.comments.find((c) => c.role === "root");
  if (!root) throw new Error(`root comment not found in thread ${thread.threadId}`);
  return root;
}

function parentOnly(thread: Thread): ParentOnlyState {
  return {
    comment: { body: rootOf(thread).body, path: thread.path },
    diffHunk: thread.diffHunk,
    pr: thread.pr ? { title: thread.pr.title } : null,
  };
}

export function buildParentOnlyState(thread: Thread): Built<ParentOnlyState> {
  const state = parentOnly(thread);
  return { state, stateHash: sha256(stableStringify({ variant: "parent-only", state })) };
}

/**
 * 除外されなかった返信を含むstate。除外: bot・unknown、または is_ack の確率が閾値以上。
 * is_ackの結果が無い返信は、除外の根拠が無いので残す。閾値はstateHashに含める。
 */
export function buildWithRepliesState(
  thread: Thread,
  ackProbabilities: Readonly<Record<string, number>>,
  replyIsAckThreshold: number,
): Built<WithRepliesState> {
  const replies = thread.comments
    .filter((c) => c.role === "reply" && !isCodeExcludedReply(c))
    .filter((c) => {
      const p = ackProbabilities[c.id];
      return p === undefined || !isAckExcluded(p, replyIsAckThreshold);
    })
    .map((c) => ({ body: c.body }));
  const state: WithRepliesState = { ...parentOnly(thread), replies };
  return {
    state,
    stateHash: sha256(stableStringify({ variant: "with-replies", state, replyIsAckThreshold })),
  };
}

/** is_ackのstate。親 + 先行する返信 + 対象の返信。投稿者名は入れず、役割だけ。 */
export function buildIsAckState(thread: Thread, replyId: string): Built<IsAckState> {
  const idx = thread.comments.findIndex((c) => c.id === replyId && c.role === "reply");
  const target = thread.comments[idx];
  if (idx < 0 || !target) throw new Error(`reply not found in thread ${thread.threadId}: ${replyId}`);
  const root = rootOf(thread);
  const earlier = thread.comments
    .slice(0, idx)
    .filter((c) => c.role === "reply")
    .map((c) => ({ role: c.role, body: c.body }));
  const state: IsAckState = {
    thread: { root: { body: root.body, path: thread.path }, earlier },
    reply: { body: target.body },
  };
  return { state, stateHash: sha256(stableStringify({ variant: "reply", state })) };
}
