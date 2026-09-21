import { describe, expect, it } from "vitest";
import type { Result, Run } from "@oss-review-lab/shared";
import { composeResults, selectViewResults } from "./compose";

const SHA = "a".repeat(64);

function result(over: Partial<Result>): Result {
  return {
    targetId: "1001",
    questionId: "types",
    questionType: "noul",
    questionDefHash: SHA,
    stateHash: SHA,
    variant: "parent-only",
    raw: null,
    probability: 0.5,
    confidence: null,
    latencyMs: 1,
    usage: null,
    cost: null,
    error: null,
    ...over,
  };
}

function run(runId: string, createdAt: string, status: Run["status"], results: Result[]): Run {
  return {
    schemaVersion: 1,
    runId,
    model: "m",
    variant: "parent-only",
    stateConfig: {},
    threadsSha256: SHA,
    questionPlanHash: SHA,
    questionDefs: [],
    createdAt,
    finishedAt: null,
    status,
    results,
  };
}

const key = (r: Result) => [r.targetId, r.questionId, r.variant, r.probability];

describe("composeResults", () => {
  it("別々のrunにある結果(観点とis_ack)を、1つに合わせる", () => {
    const composed = composeResults([
      run("ack", "2026-09-21T00:00:00Z", "complete", [
        result({ targetId: "1002", questionId: "is_ack", variant: "reply", probability: 0.97 }),
      ]),
      run("aspects", "2026-09-21T01:00:00Z", "complete", [result({ probability: 0.75 })]),
    ]);
    expect(composed.map(key)).toEqual([
      ["1002", "is_ack", "reply", 0.97],
      ["1001", "types", "parent-only", 0.75],
    ]);
  });

  it("同じ (targetId, questionId, variant) は、新しいrun(createdAt)が優先される。runの並びには依存しない", () => {
    const older = run("old", "2026-09-21T00:00:00Z", "complete", [
      result({ probability: 0.1 }),
      result({ questionId: "tests", probability: 0.6 }),
    ]);
    const newer = run("new", "2026-09-21T02:00:00Z", "complete", [result({ probability: 0.9 })]);
    for (const runs of [
      [older, newer],
      [newer, older],
    ]) {
      expect(
        composeResults(runs)
          .map(key)
          .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      ).toEqual([
        ["1001", "tests", "parent-only", 0.6],
        ["1001", "types", "parent-only", 0.9],
      ]);
    }
  });

  it("新しいrunのエラー(確率なし)も、新しいものとして古い値を置き換える", () => {
    const composed = composeResults([
      run("old", "2026-09-21T00:00:00Z", "complete", [result({ probability: 0.8 })]),
      run("new", "2026-09-21T02:00:00Z", "complete", [
        result({ probability: null, error: { kind: "fatal", message: "x", attempts: 1 } }),
      ]),
    ]);
    expect(composed.map(key)).toEqual([["1001", "types", "parent-only", null]]);
  });

  it("variantが違えば、別の結果として残る", () => {
    const composed = composeResults([
      run("a", "2026-09-21T00:00:00Z", "complete", [
        result({ probability: 0.1 }),
        result({ variant: "with-replies", probability: 0.9 }),
      ]),
    ]);
    expect(composed.map(key)).toEqual([
      ["1001", "types", "parent-only", 0.1],
      ["1001", "types", "with-replies", 0.9],
    ]);
  });

  it("partial・failedのrunは、新しくても使わない", () => {
    const composed = composeResults([
      run("done", "2026-09-21T00:00:00Z", "complete", [result({ probability: 0.2 })]),
      run("part", "2026-09-21T05:00:00Z", "partial", [result({ probability: 0.99 }), result({ questionId: "tests" })]),
      run("fail", "2026-09-21T06:00:00Z", "failed", [result({ probability: 0.98 })]),
    ]);
    expect(composed.map(key)).toEqual([["1001", "types", "parent-only", 0.2]]);
  });

  it("runが無ければ空", () => {
    expect(composeResults([])).toEqual([]);
  });
});

describe("selectViewResults", () => {
  const all = [
    result({ questionId: "is_ack", variant: "reply", targetId: "1002", probability: 0.9 }),
    result({ variant: "parent-only", probability: 0.1 }),
    result({ variant: "with-replies", probability: 0.7 }),
    result({ questionId: "is_ack", variant: "parent-only", targetId: "1002", probability: 0.2 }),
  ];

  it("is_ack は variant: reply、観点・言い方は選んだ variant だけを引く", () => {
    expect(selectViewResults(all, "parent-only").map(key)).toEqual([
      ["1002", "is_ack", "reply", 0.9],
      ["1001", "types", "parent-only", 0.1],
    ]);
    expect(selectViewResults(all, "with-replies").map(key)).toEqual([
      ["1002", "is_ack", "reply", 0.9],
      ["1001", "types", "with-replies", 0.7],
    ]);
  });
});
