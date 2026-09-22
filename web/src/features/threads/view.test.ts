import { describe, expect, it } from "vitest";
import type { Result, Thread } from "@oss-review-lab/shared";
import { DEFAULT_VIEW_PARAMS } from "../../params/params";
import type { ViewParams } from "../../params/params";
import { buildThreadView, filterThreadViews, sortThreadViewsByProbability } from "./view";

const HASH = "0".repeat(64);

function result(targetId: string, questionId: string, probability: number | null): Result {
  return {
    targetId,
    questionId,
    questionType: "noul",
    questionDefHash: HASH,
    stateHash: HASH,
    variant: "parent-only",
    raw: null,
    probability,
    confidence: null,
    latencyMs: 1,
    usage: null,
    cost: null,
    error: null,
  };
}

function thread(id: string, over: Partial<Thread> = {}, replyKinds: ("human" | "bot" | "unknown")[] = []): Thread {
  return {
    schemaVersion: 1,
    threadId: id,
    repo: "r/r",
    pr: { number: 1, url: "https://example.test/pull/1", title: "t", authorLogin: "author" },
    path: "a.ts",
    diffHunk: "",
    comments: [
      {
        id,
        role: "root",
        createdAt: "2026-01-01T00:00:00Z",
        author: "rev",
        authorKind: "human",
        isPrAuthor: false,
        body: "root",
        url: `https://example.test/${id}`,
      },
      ...replyKinds.map((kind, i) => ({
        id: `${id}-r${i}`,
        role: "reply" as const,
        createdAt: "2026-01-01T01:00:00Z",
        author: kind === "human" ? "x" : null,
        authorKind: kind,
        isPrAuthor: null,
        body: "reply",
        url: `https://example.test/${id}-r${i}`,
      })),
    ],
    excludedReason: null,
    ...over,
  };
}

const T = { labelThreshold: 0.5, ackThreshold: 0.5 };
const params = (over: Partial<ViewParams>): ViewParams => ({ ...DEFAULT_VIEW_PARAMS, ...over });

describe("buildThreadView", () => {
  it("親の結果から観点・言い方のラベルと確率を導く(閾値ちょうどは含む。エラーは無視)", () => {
    const v = buildThreadView(
      thread("1"),
      [
        result("1", "design-api", 0.5),
        result("1", "types", 0.49),
        result("1", "performance", null),
        result("1", "question", 0.9),
        result("other-thread", "tests", 0.99),
      ],
      T,
    );
    expect({ labels: v.labels, probabilities: v.probabilities, judged: v.judged }).toEqual({
      labels: { aspects: ["design-api"], styles: ["question"] },
      probabilities: { "design-api": 0.5, types: 0.49, question: 0.9 },
      judged: true,
    });
  });

  it("親の結果が無い(その観点のrunではない)ときは未判定で、ラベルを持たない", () => {
    const v = buildThreadView(thread("1"), [result("1", "is_ack", 0.9)], T);
    expect({ labels: v.labels, judged: v.judged }).toEqual({ labels: { aspects: [], styles: [] }, judged: false });
  });

  it("どの質問も閾値に届かなければ「その他」", () => {
    const v = buildThreadView(thread("1"), [result("1", "types", 0.1)], T);
    expect(v.labels).toEqual({ aspects: ["other"], styles: ["other"] });
  });

  it("除外される返信: is_ackが閾値以上(境界を含む)、bot、unknown", () => {
    const t = thread("1", {}, ["human", "human", "human", "bot", "unknown"]);
    const v = buildThreadView(
      t,
      [result("1-r0", "is_ack", 0.5), result("1-r1", "is_ack", 0.49), result("1-r2", "is_ack", null)],
      T,
    );
    expect(v.excludedReplies).toEqual([
      { id: "1-r0", reason: "ack" },
      { id: "1-r3", reason: "bot" },
      { id: "1-r4", reason: "unknown" },
    ]);
  });
});

describe("buildThreadView: 2つの閾値", () => {
  it("観点のラベルは labelThreshold、返信の除外は ackThreshold で決まり、互いに影響しない", () => {
    const t = thread("1", {}, ["human", "human"]);
    const results = [
      result("1", "types", 0.6),
      result("1-r0", "is_ack", 0.85),
      result("1-r1", "is_ack", 0.6),
    ];
    const at = (labelThreshold: number, ackThreshold: number) => {
      const v = buildThreadView(t, results, { labelThreshold, ackThreshold });
      return [v.labels.aspects, v.excludedReplies.map((e) => e.id)];
    };
    expect(at(0.5, 0.8)).toEqual([["types"], ["1-r0"]]);
    expect(at(0.7, 0.8)).toEqual([["other"], ["1-r0"]]);
    expect(at(0.5, 0.9)).toEqual([["types"], []]);
    expect(at(0.5, 0.6)).toEqual([["types"], ["1-r0", "1-r1"]]);
  });
});

describe("filterThreadViews", () => {
  const results = [
    result("1", "design-api", 0.9),
    result("1", "tests", 0.9),
    result("1", "question", 0.9),
    result("2", "security", 0.9),
    result("2", "suggests-fix", 0.9),
    result("3", "performance", 0.1),
  ];
  const threads = [
    thread("1", { comments: thread("1").comments.map((c) => ({ ...c, isPrAuthor: true })) }),
    thread("2"),
    thread("3"),
    thread("4", { excludedReason: "bot-root" }),
    thread("5", { comments: [{ ...thread("5").comments[0]!, role: "reply", isPrAuthor: null }] }),
  ];
  const views = threads.map((t) => buildThreadView(t, results, T));
  const ids = (p: Partial<ViewParams>) => filterThreadViews(views, params(p)).map((v) => v.thread.threadId);

  it("絞り込み無しなら、除外スレッド以外を全部出す", () => {
    expect(ids({})).toEqual(["1", "2", "3", "5"]);
  });

  it("除外の表示切替で、除外スレッドも出る", () => {
    expect(ids({ showExcluded: true })).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("観点を複数選ぶと、いずれかを含むスレッド(OR)", () => {
    expect(ids({ aspects: ["design-api", "security"] })).toEqual(["1", "2"]);
  });

  it("観点「その他」を選べる。未判定のスレッドは、観点の絞り込みに入らない", () => {
    expect(ids({ aspects: ["other"] })).toEqual(["3"]);
  });

  it("言い方も複数選択(OR)で、観点とは AND", () => {
    expect(ids({ styles: ["question", "suggests-fix"] })).toEqual(["1", "2"]);
    expect(ids({ aspects: ["security"], styles: ["question", "suggests-fix"] })).toEqual(["2"]);
  });

  it("発言者役割: PR作者の親 / それ以外の親(不明は、どちらにも入らない)", () => {
    expect(ids({ role: "pr-author" })).toEqual(["1"]);
    expect(ids({ role: "reviewer" })).toEqual(["2", "3"]);
  });

  it("該当ゼロなら空", () => {
    expect(ids({ aspects: ["docs-comments"] })).toEqual([]);
  });
});

describe("filterThreadViews: selfContainedOnly(OSSの知識が無くてもわかるものだけ)", () => {
  // self-contained の確率は向きが逆(生の確率=知識が要る確率)。1(生0.6)は反転後0.4(知識が要る側)、
  // 3(生0.2)は反転後0.8(知識が無くてもわかる側)。2は未判定(結果が無い)。
  const results = [result("1", "self-contained", 0.6), result("3", "self-contained", 0.2)];
  const threads = [thread("1"), thread("2"), thread("3")];
  const views = threads.map((t) => buildThreadView(t, results, T));
  const ids = (p: Partial<ViewParams>) => filterThreadViews(views, params(p)).map((v) => v.thread.threadId);

  it("既定(オフ)では、全て出る", () => {
    expect(ids({})).toEqual(["1", "2", "3"]);
  });

  it("オンにすると、反転後の確率がlabelThreshold(既定0.5)以上のものだけ残る。未判定は除く", () => {
    expect(ids({ selfContainedOnly: true })).toEqual(["3"]);
  });

  it("labelThresholdを下げると、境界(反転後ちょうど)も含まれる", () => {
    // 1の反転後は0.4なので、閾値0.4ちょうどなら含める
    expect(ids({ selfContainedOnly: true, labelThreshold: 0.4 })).toEqual(["1", "3"]);
  });
});

describe("sortThreadViewsByProbability", () => {
  it("指定した質問の確率が高い順に並べる。無い(未判定・確率なし)ものは最後、元の順を保つ", () => {
    const views = [
      buildThreadView(thread("low"), [result("low", "explains-reason", 0.2)], T),
      buildThreadView(thread("none-a"), [], T),
      buildThreadView(thread("high"), [result("high", "explains-reason", 0.9)], T),
      buildThreadView(thread("none-b"), [], T),
      buildThreadView(thread("mid"), [result("mid", "explains-reason", 0.5)], T),
    ];
    const sorted = sortThreadViewsByProbability(views, "explains-reason");
    expect(sorted.map((v) => v.thread.threadId)).toEqual(["high", "mid", "low", "none-a", "none-b"]);
    // 元の配列は変更しない
    expect(views.map((v) => v.thread.threadId)).toEqual(["low", "none-a", "high", "none-b", "mid"]);
  });

  it("同じ確率は、元の順を保つ(安定ソート)", () => {
    const views = [
      buildThreadView(thread("a"), [result("a", "explains-reason", 0.5)], T),
      buildThreadView(thread("b"), [result("b", "explains-reason", 0.5)], T),
    ];
    expect(sortThreadViewsByProbability(views, "explains-reason").map((v) => v.thread.threadId)).toEqual(["a", "b"]);
  });
});
