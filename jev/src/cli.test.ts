import { describe, expect, it } from "vitest";
import { formatDryRun, parseCommand } from "./cli";

const env = { dataDir: "/d", pricingPath: "/p.json" };

const base = {
  dataDir: "/d",
  pricingPath: "/p.json",
  variant: "parent-only",
  isAck: false,
  split: false,
  budget: 3.5,
  concurrency: 3,
  replyIsAckThreshold: 0.5,
};

describe("parseCommand", () => {
  it("--dry-run: 既定値を補う", () => {
    expect(parseCommand(["run", "--dry-run"], env)).toEqual({ command: "run", options: { ...base, mode: "dry-run" } });
  });

  it("--limit N は mode limit。全オプションを解釈する", () => {
    expect(
      parseCommand(
        [
          "run", "--limit", "2", "--variant", "with-replies", "--split", "--budget", "1.5", "--concurrency", "2",
          "--questions", "design-api,types", "--max-cost-per-request", "0.4", "--resolve", "skip",
          "--observed-cost", "0.02", "--reply-is-ack-threshold", "0.8",
        ],
        env,
      ),
    ).toEqual({
      command: "run",
      options: {
        ...base,
        mode: "limit",
        limit: 2,
        variant: "with-replies",
        split: true,
        budget: 1.5,
        concurrency: 2,
        questionIds: ["design-api", "types"],
        maxCostPerRequest: 0.4,
        resolve: "skip",
        observedCost: 0.02,
        replyIsAckThreshold: 0.8,
      },
    });
  });

  it("--all / --is-ack", () => {
    expect(parseCommand(["run", "--all", "--is-ack"], env)).toEqual({
      command: "run",
      options: { ...base, mode: "all", isAck: true },
    });
  });

  it("モードが無い・重複・不正な値は拒否する", () => {
    expect(() => parseCommand(["run"], env)).toThrow("--dry-run、--limit N、--all のどれかを指定してください");
    expect(() => parseCommand(["run", "--all", "--limit", "1"], env)).toThrow("--all と --limit は同時に指定できません");
    expect(() => parseCommand(["run", "--limit", "abc"], env)).toThrow("--limit は1以上の整数にしてください: abc");
    expect(() => parseCommand(["run", "--all", "--budget=-1"], env)).toThrow("--budget は有限で非負の数値にしてください: -1");
    expect(() => parseCommand(["run", "--all", "--variant", "x"], env)).toThrow("--variant は parent-only か with-replies にしてください: x");
    expect(() => parseCommand(["run", "--all", "--resolve", "x"], env)).toThrow("--resolve は retry か skip にしてください: x");
    expect(() => parseCommand(["run", "--all", "--observed-cost=-1"], env)).toThrow("--observed-cost は有限で非負の数値にしてください: -1");
    expect(() => parseCommand(["run", "--all", "--max-cost-per-request", "0"], env)).toThrow("--max-cost-per-request は有限で正の数値にしてください: 0");
    expect(() => parseCommand(["run", "--all", "--nope"], env)).toThrow("Unknown option '--nope'");
  });

  it("report: --run と --observed-cost", () => {
    expect(parseCommand(["report"], env)).toEqual({ command: "report", dataDir: "/d", runId: undefined, observedCost: undefined });
    expect(parseCommand(["report", "--run", "r1", "--observed-cost", "0.3"], env)).toEqual({
      command: "report",
      dataDir: "/d",
      runId: "r1",
      observedCost: 0.3,
    });
  });

  it("未知のコマンドは使い方を出す", () => {
    expect(() => parseCommand(["x"], env)).toThrow("使い方:");
  });
});

describe("formatDryRun", () => {
  it("対象数・質問数・リクエスト数・見積もりを出す", () => {
    expect(
      formatDryRun({
        targets: 3, questions: 15, requests: 3, cachedRequests: 1, requestsToSend: 2,
        reservePerRequest: 0.5, estimatedCost: 1, note: "見積もりは --max-cost-per-request による上限です",
      }),
    ).toBe(
      [
        "[dry-run] Jev APIは呼びません",
        "対象: 3 件 / 質問: 15 問",
        "リクエスト: 3 件(キャッシュ済み 1 件、送信 2 件)",
        "1リクエストあたりの予約額: 0.5 ドル",
        "見積もり費用: 1 ドル",
        "注: 見積もりは --max-cost-per-request による上限です",
      ].join("\n"),
    );
    expect(
      formatDryRun({
        targets: 1, questions: 15, requests: 1, cachedRequests: 0, requestsToSend: 1,
        reservePerRequest: null, estimatedCost: null, note: "n",
      }),
    ).toBe(
      [
        "[dry-run] Jev APIは呼びません",
        "対象: 1 件 / 質問: 15 問",
        "リクエスト: 1 件(キャッシュ済み 0 件、送信 1 件)",
        "1リクエストあたりの予約額: 不明",
        "見積もり費用: 不明",
        "注: n",
      ].join("\n"),
    );
  });
});
