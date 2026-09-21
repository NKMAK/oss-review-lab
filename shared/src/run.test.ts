import { describe, expect, it } from "vitest";
import { ManifestSchema, ResultSchema, RunSchema } from "./run";

const h = (c: string) => c.repeat(64);

const validResult = {
  targetId: "1002",
  questionId: "is_ack",
  questionType: "noul",
  questionDefHash: h("a"),
  stateHash: h("b"),
  variant: "reply",
  raw: { type: "noul", noul: 0.9 },
  probability: 0.9,
  confidence: null,
  latencyMs: 120,
  usage: { inputTokens: 100, outputTokens: 2 },
  cost: 0.001,
  error: null,
};
const validRun = {
  schemaVersion: 1,
  runId: "run-1",
  model: "jev-0.0.0-dummy",
  variant: "reply",
  stateConfig: { replyIsAckThreshold: 0.8 },
  threadsSha256: h("c"),
  questionPlanHash: h("d"),
  questionDefs: [{ id: "is_ack", hash: h("a") }],
  createdAt: "2026-09-21T00:00:00Z",
  finishedAt: null,
  status: "partial",
  results: [validResult],
};
const validManifest = {
  schemaVersion: 1,
  sources: [{ file: "raw/rc_a_b.jsonl", sha256: h("e"), repo: "a/b", fetchedAt: "2026-09-20T00:00:00Z" }],
  threads: { file: "threads/threads.jsonl", sha256: h("c"), count: 1 },
  runs: [
    {
      runId: "run-1",
      status: "partial",
      file: "runs/run-1.json",
      sha256: h("f"),
      createdAt: "2026-09-21T00:00:00Z",
      variant: "reply",
    },
  ],
};

describe("ResultSchema", () => {
  it("正しい結果を受理する", () => {
    expect(ResultSchema.parse(validResult)).toEqual(validResult);
  });
  it("エラー結果(確率null・usageなし)を受理する", () => {
    const r = {
      ...validResult,
      probability: null,
      usage: null,
      cost: null,
      error: { kind: "fatal", message: "dummy", attempts: 1, stopReason: "budget" },
    };
    expect(ResultSchema.parse(r)).toEqual(r);
  });
  it("確率が範囲外なら拒否する", () => {
    expect(ResultSchema.safeParse({ ...validResult, probability: 1.1 }).success).toBe(false);
    expect(ResultSchema.safeParse({ ...validResult, probability: -0.1 }).success).toBe(false);
    expect(ResultSchema.safeParse({ ...validResult, probability: Number.NaN }).success).toBe(false);
  });
  it("必須項目(questionId)の欠落を拒否する", () => {
    const { questionId: _omit, ...rest } = validResult;
    expect(ResultSchema.safeParse(rest).success).toBe(false);
  });
  it("負のトークン数・小数のトークン数を拒否する", () => {
    expect(
      ResultSchema.safeParse({ ...validResult, usage: { inputTokens: -1, outputTokens: 2 } }).success,
    ).toBe(false);
    expect(
      ResultSchema.safeParse({ ...validResult, usage: { inputTokens: 1.5, outputTokens: 2 } }).success,
    ).toBe(false);
  });
});

describe("RunSchema", () => {
  it("正しいRunを受理する", () => {
    expect(RunSchema.parse(validRun)).toEqual(validRun);
  });
  it("status が未知なら拒否する", () => {
    expect(RunSchema.safeParse({ ...validRun, status: "done" }).success).toBe(false);
  });
  it("hash が64桁の16進でなければ拒否する", () => {
    expect(RunSchema.safeParse({ ...validRun, threadsSha256: "xyz" }).success).toBe(false);
  });
});

describe("ManifestSchema", () => {
  it("正しいManifestを受理する", () => {
    expect(ManifestSchema.parse(validManifest)).toEqual(validManifest);
  });
  it.each([
    ["..を含む", "../secret.json"],
    ["途中に..を含む", "runs/../../secret.json"],
    ["絶対パス", "/etc/passwd"],
    ["URL", "https://example.test/x.json"],
    ["バックスラッシュ", "runs\\x.json"],
    ["ドライブ文字", "C:x.json"],
    ["空セグメント", "runs//x.json"],
    ["空文字", ""],
  ])("threads.file が %s なら拒否する", (_name, file) => {
    const m = { ...validManifest, threads: { ...validManifest.threads, file } };
    expect(ManifestSchema.safeParse(m).success).toBe(false);
  });
  it("runs[].file に .. があれば拒否する", () => {
    const m = { ...validManifest, runs: [{ ...validManifest.runs[0], file: "../x.json" }] };
    expect(ManifestSchema.safeParse(m).success).toBe(false);
  });
  it("sources[].file に .. があれば拒否する", () => {
    const m = { ...validManifest, sources: [{ ...validManifest.sources[0], file: "../x.jsonl" }] };
    expect(ManifestSchema.safeParse(m).success).toBe(false);
  });
  it("必須項目(threads)の欠落を拒否する", () => {
    const { threads: _omit, ...rest } = validManifest;
    expect(ManifestSchema.safeParse(rest).success).toBe(false);
  });
});
