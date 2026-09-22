import { describe, expect, it } from "vitest";
import manifestJson from "../fixtures/data/index.json";
import runAck from "../fixtures/data/runs/run-20260921-ack.json";
import runAspects from "../fixtures/data/runs/run-20260921-aspects.json";
import runPartial from "../fixtures/data/runs/run-20260921-partial.json";
import runWithReplies from "../fixtures/data/runs/run-20260921-with-replies.json";
import threadsJsonl from "../fixtures/data/threads/threads.jsonl?raw";
import { ManifestSchema, RunSchema } from "./run";
import { ThreadSchema } from "./thread";
import { deriveLabels, isCodeExcludedReply, selfContainedProbability } from "./derive";

const runFiles: Record<string, unknown> = {
  "runs/run-20260921-ack.json": runAck,
  "runs/run-20260921-aspects.json": runAspects,
  "runs/run-20260921-partial.json": runPartial,
  "runs/run-20260921-with-replies.json": runWithReplies,
};
const threads = threadsJsonl
  .split("\n")
  .filter((l) => l !== "")
  .map((l) => ThreadSchema.parse(JSON.parse(l)));

describe("fixtures", () => {
  it("Manifestがスキーマを通り、runsのfileが実在するfixturesと一致する", () => {
    const m = ManifestSchema.parse(manifestJson);
    expect(m.runs.map((r) => r.file).sort()).toEqual(Object.keys(runFiles).sort());
    expect(m.threads.count).toBe(threads.length);
    expect(m.runs.map((r) => [r.runId, r.status])).toEqual([
      ["run-20260921-ack", "complete"],
      ["run-20260921-aspects", "complete"],
      ["run-20260921-with-replies", "complete"],
      ["run-20260921-partial", "partial"],
    ]);
    expect(m.runs.map((r) => r.variant)).toEqual(["reply", "parent-only", "with-replies", "parent-only"]);
  });

  it("全Runがスキーマを通り、Manifestの目録とRun自身が一致する", () => {
    const m = ManifestSchema.parse(manifestJson);
    for (const entry of m.runs) {
      const run = RunSchema.parse(runFiles[entry.file]);
      expect([run.runId, run.status, run.variant, run.createdAt, run.threadsSha256]).toEqual([
        entry.runId,
        entry.status,
        entry.variant,
        entry.createdAt,
        m.threads.sha256,
      ]);
    }
  });

  it("スレッドのケース(bot親・削除済み親・全返信が同意のみ・複数観点・親欠落)を含む", () => {
    expect(threads.map((t) => [t.threadId, t.excludedReason, t.comments.length])).toEqual([
      ["1001", null, 5],
      ["2001", "bot-root", 2],
      ["3001", "unknown-root", 1],
      ["4001", null, 4],
      ["5001", "parent-missing", 1],
    ]);
    expect(threads[0]?.comments.filter(isCodeExcludedReply).map((c) => c.id)).toEqual(["1003", "1004"]);
  });

  it("is_ack の確率が0.1〜0.99に散らばる", () => {
    const run = RunSchema.parse(runAck);
    expect(run.results.map((r) => [r.targetId, r.probability])).toEqual([
      ["1002", 0.97],
      ["1005", 0.1],
      ["4002", 0.99],
      ["4003", 0.85],
      ["4004", 0.5],
      ["1003", 0.3],
      ["2002", 0.8],
      ["5002", 0.65],
    ]);
  });

  it("複数観点のスレッドが、導出で複数ラベルになる(エラーの質問は無視)", () => {
    const run = RunSchema.parse(runAspects);
    const r1001 = run.results.filter((r) => r.targetId === "1001");
    expect(r1001.length).toBe(16);
    expect(deriveLabels(r1001, 0.5)).toEqual({
      aspects: ["design-api", "types", "tests"],
      styles: ["explains-reason"],
    });
    expect(r1001.filter((r) => r.error !== null).map((r) => r.questionId)).toEqual(["performance"]);
  });

  it("self-contained(理解のしやすさ)の結果がある。1001は知識が無くてもわかる側、4001は要る側", () => {
    const run = RunSchema.parse(runAspects);
    const selfContainedOf = (targetId: string) =>
      run.results.find((r) => r.targetId === targetId && r.questionId === "self-contained")?.probability ?? null;
    // raw(知識が要る確率)なので、Web側では 1 - probability にして使う(selfContainedProbability)
    expect(selfContainedOf("1001")).toBe(0.3);
    expect(selfContainedProbability(selfContainedOf("1001")!)).toBeCloseTo(0.7, 10);
    expect(selfContainedOf("4001")).toBe(0.8);
    expect(selfContainedProbability(selfContainedOf("4001")!)).toBeCloseTo(0.2, 10);
  });

  it("複数の質問を1リクエストで送った形: cost と usage はリクエストの先頭の Result にだけ入り、応答時間は同じリクエストで同じ値", () => {
    const m = ManifestSchema.parse(manifestJson);
    for (const entry of m.runs.filter((r) => r.variant !== "reply")) {
      const run = RunSchema.parse(runFiles[entry.file]);
      const byTarget = new Map<string, typeof run.results>();
      for (const r of run.results) byTarget.set(r.targetId, [...(byTarget.get(r.targetId) ?? []), r]);
      for (const [targetId, rs] of byTarget) {
        const [head, ...rest] = rs;
        expect([entry.runId, targetId, head?.cost, head?.usage]).toEqual([
          entry.runId,
          targetId,
          expect.any(Number),
          expect.objectContaining({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) }),
        ]);
        expect(rest.map((r) => [r.cost, r.usage])).toEqual(rest.map(() => [null, null]));
        expect(new Set(rs.map((r) => r.latencyMs)).size).toBe(1);
      }
    }
  });

  it("is_ack のrunは、返信ごとに1リクエスト(全Resultが cost を持つ)", () => {
    const run = RunSchema.parse(runAck);
    expect(run.results.every((r) => r.cost !== null && r.usage !== null)).toBe(true);
  });

  it("with-replies のrunは、4001だけが判定済みで、parent-only と違うラベルになる", () => {
    const withReplies = RunSchema.parse(runWithReplies);
    expect([...new Set(withReplies.results.map((r) => r.targetId))]).toEqual(["4001"]);
    expect(withReplies.results.every((r) => r.variant === "with-replies")).toBe(true);
    expect(deriveLabels(withReplies.results, 0.5)).toEqual({ aspects: ["tests"], styles: ["other"] });
    const parentOnly = RunSchema.parse(runAspects).results.filter((r) => r.targetId === "4001");
    expect(deriveLabels(parentOnly, 0.5)).toEqual({ aspects: ["design-api"], styles: ["question"] });
  });

  it("partial のrunは、使われたら分かる値(1001に security 0.95)を持つ", () => {
    const run = RunSchema.parse(runPartial);
    expect(run.status).toBe("partial");
    expect(run.finishedAt).toBe(null);
    expect(run.results.map((r) => [r.targetId, r.questionId, r.probability])).toEqual([
      ["1001", "design-api", 0],
      ["1001", "types", 0],
      ["1001", "security", 0.95],
    ]);
  });

  it("全ファイルのURLが https://example.test/ だけで、本物のGitHubを含まない", () => {
    const all = [JSON.stringify(manifestJson), threadsJsonl, JSON.stringify(runAck), JSON.stringify(runAspects), JSON.stringify(runPartial), JSON.stringify(runWithReplies)].join("\n");
    const urls = all.match(/https?:\/\/[^\s"\\]+/g) ?? [];
    expect(urls.filter((u) => !u.startsWith("https://example.test/"))).toEqual([]);
    expect(/github\.com|nestjs/i.test(all)).toBe(false);
  });
});
