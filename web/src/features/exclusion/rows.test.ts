import { describe, expect, it } from "vitest";
import type { Result, Thread } from "@oss-review-lab/shared";
import { buildExclusionRows } from "./rows";

function comment(id: string, role: "root" | "reply", authorKind: "human" | "bot" | "unknown", body: string) {
  return {
    id,
    role,
    createdAt: "2026-09-01T00:00:00Z",
    author: authorKind === "unknown" ? null : `user-${id}`,
    authorKind,
    isPrAuthor: null,
    body,
    url: `https://example.test/c/${id}`,
  };
}

function thread(threadId: string, comments: Thread["comments"], pr: Thread["pr"] = null): Thread {
  return {
    schemaVersion: 1,
    threadId,
    repo: "example-org/example-repo",
    pr,
    path: "a.ts",
    diffHunk: "",
    comments,
    excludedReason: null,
  };
}

function result(targetId: string, questionId: string, probability: number | null): Result {
  return {
    targetId,
    questionId,
    questionType: "noul",
    questionDefHash: "a".repeat(64),
    stateHash: "b".repeat(64),
    variant: "reply",
    raw: null,
    probability,
    confidence: null,
    latencyMs: 1,
    usage: null,
    cost: null,
    error: null,
  };
}

const t1 = thread("1", [
  comment("1", "root", "human", "root1"),
  comment("2", "reply", "human", "reply2"),
  comment("3", "reply", "bot", "reply3"),
  comment("4", "reply", "human", "reply4"),
]);
const t2 = thread("10", [comment("11", "reply", "human", "orphan11")]);

describe("buildExclusionRows", () => {
  it("is_ack の確率の降順に並べ、親と先行返信・コード除外を付ける", () => {
    const rows = buildExclusionRows(
      [t1, t2],
      [
        result("2", "is_ack", 0.5),
        result("4", "is_ack", 0.9),
        result("3", "is_ack", 0.7),
        result("11", "is_ack", 0.7),
      ],
    );
    expect(
      rows.map((r) => ({
        replyId: r.reply.id,
        probability: r.probability,
        parent: r.parent?.id ?? null,
        prior: r.priorReplies.map((c) => c.id),
        codeExcluded: r.codeExcluded,
      })),
    ).toEqual([
      { replyId: "4", probability: 0.9, parent: "1", prior: ["2", "3"], codeExcluded: false },
      { replyId: "3", probability: 0.7, parent: "1", prior: ["2"], codeExcluded: true },
      { replyId: "11", probability: 0.7, parent: null, prior: [], codeExcluded: false },
      { replyId: "2", probability: 0.5, parent: "1", prior: [], codeExcluded: false },
    ]);
  });

  it("is_ack 以外の結果、確率がnullの結果、親コメントへの結果、存在しない対象は無視する", () => {
    const rows = buildExclusionRows(
      [t1],
      [
        result("2", "aspect_x", 0.9),
        result("4", "is_ack", null),
        result("1", "is_ack", 0.9),
        result("999", "is_ack", 0.9),
      ],
    );
    expect(rows).toEqual([]);
  });
});
