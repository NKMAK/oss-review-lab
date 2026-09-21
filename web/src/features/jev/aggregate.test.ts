import type { Result } from "@oss-review-lab/shared";
import { describe, expect, it } from "vitest";
import { aggregateResults } from "./aggregate";

const HASH = "0".repeat(64);

function result(over: Partial<Result>): Result {
  return {
    targetId: "1001",
    questionId: "design-api",
    questionType: "noul",
    questionDefHash: HASH,
    stateHash: HASH,
    variant: "parent-only",
    raw: null,
    probability: 0.5,
    confidence: null,
    latencyMs: 100,
    usage: null,
    cost: null,
    error: null,
    ...over,
  };
}

describe("aggregateResults", () => {
  it("結果が空なら、空の集計を返す", () => {
    expect(aggregateResults([])).toEqual({
      resultCount: 0,
      errorCount: 0,
      questionCount: 0,
      questions: [],
      latency: null,
      billing: { requestCount: 0, totalCost: 0, inputTokens: 0, outputTokens: 0 },
    });
  });

  it("確率を10個の区間(0.1刻み。1.0は最後の区間)に数え、質問ごとに、出現順で分ける", () => {
    const results = [
      result({ questionId: "types", probability: 0 }),
      result({ questionId: "types", probability: 0.09 }),
      result({ questionId: "types", probability: 0.1 }),
      result({ questionId: "types", probability: 0.3 }),
      result({ questionId: "types", probability: 0.7 }),
      result({ questionId: "types", probability: 1 }),
      result({ questionId: "tests", probability: 0.95 }),
    ];
    expect(aggregateResults(results).questions).toEqual([
      { questionId: "types", questionType: "noul", count: 6, errorCount: 0, bins: [2, 1, 0, 1, 0, 0, 0, 1, 0, 1], meanConfidence: null },
      { questionId: "tests", questionType: "noul", count: 1, errorCount: 0, bins: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1], meanConfidence: null },
    ]);
  });

  it("エラーのResultは、確率の分布に入れず、件数として別に数える", () => {
    const results = [
      result({ probability: 0.2 }),
      result({
        probability: null,
        error: { kind: "fatal", message: "boom", attempts: 3 },
      }),
      result({ probability: null }),
    ];
    const agg = aggregateResults(results);
    expect(agg.resultCount).toBe(3);
    expect(agg.errorCount).toBe(1);
    expect(agg.questions).toEqual([
      { questionId: "design-api", questionType: "noul", count: 1, errorCount: 1, bins: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0], meanConfidence: null },
    ]);
  });

  it("confidenceは、choice/scoreの質問だけが平均を持つ(noulは null)", () => {
    const results = [
      result({ questionId: "n", questionType: "noul", probability: 0.5, confidence: null }),
      result({ questionId: "c", questionType: "choice", probability: 0.5, confidence: 0.5 }),
      result({ questionId: "c", questionType: "choice", probability: 0.5, confidence: 1 }),
    ];
    expect(aggregateResults(results).questions.map((q) => [q.questionId, q.meanConfidence])).toEqual([
      ["n", null],
      ["c", 0.75],
    ]);
  });

  it("質問数は、質問IDの種類の数", () => {
    const results = [
      result({ questionId: "a" }),
      result({ questionId: "a", targetId: "1002" }),
      result({ questionId: "b" }),
    ];
    expect(aggregateResults(results).questionCount).toBe(2);
  });

  it("応答時間は、全Resultの最小・平均・中央値・最大", () => {
    const results = [100, 200, 300, 1000].map((latencyMs) => result({ latencyMs }));
    expect(aggregateResults(results).latency).toEqual({
      count: 4,
      minMs: 100,
      meanMs: 400,
      medianMs: 250,
      maxMs: 1000,
    });
  });

  it("費用は cost の合計。usage は同じリクエストの全Resultに重複して入るので、costのあるResult(リクエストの先頭)だけを数える(二重計上しない)", () => {
    const usageA = { inputTokens: 100, outputTokens: 10 };
    const usageB = { inputTokens: 200, outputTokens: 20 };
    const results = [
      // リクエストA: 3つのResult。costは先頭だけ、usageは3つとも同じ
      result({ targetId: "1001", questionId: "q1", usage: usageA, cost: 0.01 }),
      result({ targetId: "1001", questionId: "q2", usage: usageA, cost: null }),
      result({ targetId: "1001", questionId: "q3", usage: usageA, cost: null }),
      // リクエストB: 2つのResult
      result({ targetId: "1002", questionId: "q1", usage: usageB, cost: 0.02 }),
      result({ targetId: "1002", questionId: "q2", usage: usageB, cost: null }),
    ];
    expect(aggregateResults(results).billing).toEqual({
      requestCount: 2,
      totalCost: 0.03,
      inputTokens: 300,
      outputTokens: 30,
    });
  });

  it("浮動小数点の誤差が、費用の合計に出ない(0.1 + 0.2)", () => {
    const results = [
      result({ questionId: "a", cost: 0.1, usage: { inputTokens: 1, outputTokens: 1 } }),
      result({ questionId: "b", cost: 0.2, usage: { inputTokens: 1, outputTokens: 1 } }),
    ];
    expect(aggregateResults(results).billing.totalCost).toBe(0.3);
  });

  it("costが入っているが usage が null のResultは、リクエストとして数え、トークンは足さない", () => {
    const results = [result({ cost: 0.5, usage: null })];
    expect(aggregateResults(results).billing).toEqual({
      requestCount: 1,
      totalCost: 0.5,
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});
