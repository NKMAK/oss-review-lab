import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Comment, Thread } from "../../shared/src/index";
import {
  buildIsAckState,
  buildParentOnlyState,
  buildWithRepliesState,
  selectAckTargets,
  selectTargetThreads,
  stableStringify,
} from "./state";

function comment(over: Partial<Comment> & Pick<Comment, "id" | "role" | "body">): Comment {
  return {
    createdAt: "2026-01-01T00:00:00Z",
    author: "someone-dummy",
    authorKind: "human",
    isPrAuthor: false,
    url: `https://example.test/c/${over.id}`,
    ...over,
  };
}

function thread(over: Partial<Thread> = {}): Thread {
  return {
    schemaVersion: 1,
    threadId: "1",
    repo: "example-org/example-repo",
    pr: { number: 11, url: "https://example.test/pull/11", title: "Dummy PR", authorLogin: "alice-dummy" },
    path: "src/a.ts",
    diffHunk: "@@ -1 +1 @@\n-a\n+b",
    comments: [
      comment({ id: "1", role: "root", body: "root body", author: "reviewer-dummy" }),
      comment({ id: "2", role: "reply", body: "first reply", author: "alice-dummy", isPrAuthor: true }),
      comment({ id: "3", role: "reply", body: "bot reply", author: "bot-dummy[bot]", authorKind: "bot" }),
      comment({ id: "4", role: "reply", body: "deleted reply", author: null, authorKind: "unknown", isPrAuthor: null }),
      comment({ id: "5", role: "reply", body: "last reply", author: "reviewer-dummy" }),
    ],
    excludedReason: null,
    ...over,
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("stableStringify", () => {
  it("キーの順序に依存せず、同じ内容なら同じ文字列になる", () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(stableStringify({ a: [{ c: 3, d: 2 }], b: 1 })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
});

describe("selectTargetThreads", () => {
  it("excludedReasonがnullで、親がhumanのスレッドだけを選ぶ", () => {
    const ok = thread({ threadId: "ok" });
    const botRoot = thread({ threadId: "bot", excludedReason: "bot-root" });
    const humanButExcluded = thread({ threadId: "missing", excludedReason: "parent-missing" });
    const botAuthorNotExcluded = thread({
      threadId: "botauthor",
      comments: [comment({ id: "9", role: "root", body: "x", authorKind: "bot" })],
    });
    expect(selectTargetThreads([ok, botRoot, humanButExcluded, botAuthorNotExcluded]).map((t) => t.threadId)).toEqual([
      "ok",
    ]);
  });
});

describe("selectAckTargets", () => {
  it("bot・unknownを除く返信だけを、順序どおりに返す(親は含まない)", () => {
    expect(selectAckTargets(thread()).map((c) => c.id)).toEqual(["2", "5"]);
  });
});

describe("buildParentOnlyState", () => {
  it("親の本文・path・diffHunk・PRタイトルだけで、返信と投稿者名を含まない", () => {
    const { state, stateHash } = buildParentOnlyState(thread());
    expect(state).toEqual({
      comment: { body: "root body", path: "src/a.ts" },
      diffHunk: "@@ -1 +1 @@\n-a\n+b",
      pr: { title: "Dummy PR" },
    });
    expect(stateHash).toBe(sha(stableStringify({ variant: "parent-only", state })));
    expect(JSON.stringify(state)).not.toContain("reviewer-dummy");
    expect(JSON.stringify(state)).not.toContain("alice-dummy");
  });

  it("PRが不明ならprはnull", () => {
    expect(buildParentOnlyState(thread({ pr: null })).state.pr).toBe(null);
  });

  it("本文が1文字違えばstateHashが変わる", () => {
    const a = buildParentOnlyState(thread()).stateHash;
    const t = thread();
    t.comments[0] = comment({ id: "1", role: "root", body: "root body!" });
    expect(buildParentOnlyState(t).stateHash).not.toBe(a);
  });
});

describe("buildWithRepliesState", () => {
  it("bot・unknown・is_ackが閾値以上の返信を除き、残りの返信本文だけを含む", () => {
    const { state } = buildWithRepliesState(thread(), { "2": 0.9, "5": 0.1 }, 0.8);
    expect(state).toEqual({
      comment: { body: "root body", path: "src/a.ts" },
      diffHunk: "@@ -1 +1 @@\n-a\n+b",
      pr: { title: "Dummy PR" },
      replies: [{ body: "last reply" }],
    });
  });

  it("is_ackの確率が閾値ちょうどなら除外する(境界)", () => {
    const { state } = buildWithRepliesState(thread(), { "2": 0.8, "5": 0.79 }, 0.8);
    expect(state.replies).toEqual([{ body: "last reply" }]);
  });

  it("is_ackの結果が無い返信は残す(除外の根拠が無いため)", () => {
    const { state } = buildWithRepliesState(thread(), {}, 0.8);
    expect(state.replies).toEqual([{ body: "first reply" }, { body: "last reply" }]);
  });

  it("閾値がstateHashに含まれる(同じstateでも、閾値が違えば別のhash)", () => {
    const a = buildWithRepliesState(thread(), { "2": 0.5, "5": 0.5 }, 0.8);
    const b = buildWithRepliesState(thread(), { "2": 0.5, "5": 0.5 }, 0.9);
    expect(a.state).toEqual(b.state);
    expect(a.stateHash).toBe(sha(stableStringify({ variant: "with-replies", state: a.state, replyIsAckThreshold: 0.8 })));
    expect(a.stateHash).not.toBe(b.stateHash);
  });

  it("投稿者名を含まない", () => {
    const { state } = buildWithRepliesState(thread(), {}, 0.8);
    expect(JSON.stringify(state)).not.toContain("alice-dummy");
    expect(JSON.stringify(state)).not.toContain("reviewer-dummy");
  });
});

describe("buildIsAckState", () => {
  it("親と先行する返信(役割つき)と対象の返信だけを含み、投稿者名を含まない", () => {
    const { state, stateHash } = buildIsAckState(thread(), "5");
    expect(state).toEqual({
      thread: {
        root: { body: "root body", path: "src/a.ts" },
        earlier: [
          { role: "reply", body: "first reply" },
          { role: "reply", body: "bot reply" },
          { role: "reply", body: "deleted reply" },
        ],
      },
      reply: { body: "last reply" },
    });
    expect(stateHash).toBe(sha(stableStringify({ variant: "reply", state })));
    const json = JSON.stringify(state);
    for (const name of ["reviewer-dummy", "alice-dummy", "bot-dummy"]) expect(json).not.toContain(name);
  });

  it("最初の返信なら、earlierは空", () => {
    expect(buildIsAckState(thread(), "2").state.thread.earlier).toEqual([]);
  });

  it("対象が返信でなければエラー", () => {
    expect(() => buildIsAckState(thread(), "1")).toThrow("reply not found in thread 1: 1");
    expect(() => buildIsAckState(thread(), "999")).toThrow("reply not found in thread 1: 999");
  });
});
