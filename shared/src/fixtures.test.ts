import { describe, expect, it } from "vitest";
import manifestJson from "../fixtures/data/index.json";
import runAck from "../fixtures/data/runs/run-20260921-ack.json";
import runAspects from "../fixtures/data/runs/run-20260921-aspects.json";
import threadsJsonl from "../fixtures/data/threads/threads.jsonl?raw";
import { ManifestSchema, RunSchema } from "./run";
import { ThreadSchema } from "./thread";
import { deriveLabels, isCodeExcludedReply } from "./derive";

const runFiles: Record<string, unknown> = {
  "runs/run-20260921-ack.json": runAck,
  "runs/run-20260921-aspects.json": runAspects,
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
      ["run-20260921-aspects", "partial"],
    ]);
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
    expect(r1001.length).toBe(15);
    expect(deriveLabels(r1001, 0.5)).toEqual({
      aspects: ["design-api", "types", "tests"],
      styles: ["explains-reason"],
    });
    expect(r1001.filter((r) => r.error !== null).map((r) => r.questionId)).toEqual(["performance"]);
  });

  it("全ファイルのURLが https://example.test/ だけで、本物のGitHubを含まない", () => {
    const all = [JSON.stringify(manifestJson), threadsJsonl, JSON.stringify(runAck), JSON.stringify(runAspects)].join("\n");
    const urls = all.match(/https?:\/\/[^\s"\\]+/g) ?? [];
    expect(urls.filter((u) => !u.startsWith("https://example.test/"))).toEqual([]);
    expect(/github\.com|nestjs/i.test(all)).toBe(false);
  });
});
