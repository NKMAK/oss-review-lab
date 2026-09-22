import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestSchema, RunSchema } from "@oss-review-lab/shared";
import type { Run } from "@oss-review-lab/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBuildThreads } from "./build-threads";
import { importRaw, sha256Hex } from "./import-raw";
import { Ledger, LockHeldError, acquireLock } from "./ledger";
import { buildReport, formatReport, recordObservedCost } from "./report";
import { loadApiKey, planDryRun, runJev } from "./run";
import type { RunJevOptions } from "./run";
import { loadQuestionDefs, questionDefHash, questionPlanHash } from "./questions";

const API_KEY = "test-key-not-real";
const NOW = new Date("2026-09-22T00:00:00.000Z");

/**
 * 単価: 入力は0(予約額は、リクエストの大きさ×入力単価が加わるため、既存の数値を保つ)、10出力トークン=0.2 → 1リクエスト 0.2。
 * 入力単価を持つ場合の、予約額の大きさへの依存は、専用のテストで見る。
 */
const PRICING = { schemaVersion: 1, inputUsdPerToken: 0, outputUsdPerToken: 0.02 };
const USAGE = { input_tokens: 100, output_tokens: 10 };

let dir: string;
let dataDir: string;
let pricingPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-test-"));
  dataDir = join(dir, "data");
  pricingPath = join(dir, "pricing.json");
  writeFileSync(pricingPath, JSON.stringify(PRICING));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type ThreadSpec = { bodyKey?: string };

/** rc/prsの生データを書き、本物の import-raw と build-threads でスレッドにする。 */
function seedThreads(count: number, spec: (i: number) => ThreadSpec = () => ({})): void {
  const from = join(dir, "from");
  mkdirSync(from, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const key = spec(i).bodyKey ?? String(i);
    const rootId = 1000 + i * 10;
    const at = (m: number) => `2026-01-01T00:${String(m).padStart(2, "0")}:00Z`;
    lines.push(
      JSON.stringify({
        id: rootId,
        created_at: at(i),
        pull_request_url: "https://example.test/repos/example/repo/pulls/7",
        html_url: `https://example.test/c/${rootId}`,
        body: `root body ${key}`,
        path: "src/a.ts",
        diff_hunk: "@@ -1 +1 @@",
        user: { login: "Reviewer1", type: "User" },
      }),
      JSON.stringify({
        id: rootId + 1,
        created_at: at(i + 30),
        pull_request_url: "https://example.test/repos/example/repo/pulls/7",
        html_url: `https://example.test/c/${rootId + 1}`,
        body: `reply body ${key}`,
        in_reply_to_id: rootId,
        user: { login: "Author1", type: "User" },
      }),
    );
  }
  writeFileSync(join(from, "rc_example_repo.jsonl"), `${lines.join("\n")}\n`);
  writeFileSync(
    join(from, "prs_example_repo.json"),
    JSON.stringify([{ number: 7, title: "dummy PR 7", url: "https://example.test/example/repo/pull/7", author: { login: "author1" } }]),
  );
  importRaw({ from, dataDir });
  runBuildThreads({ dataDir });
}

type Call = { url: string; body: { state: unknown; model: string; questions: Record<string, unknown> } };
type Responder = (callIndex: number, call: Call) => Response | Error | Promise<Response>;

function okResponse(call: Call, usage: unknown = USAGE): Response {
  const answers = Object.fromEntries(Object.keys(call.body.questions).map((id) => [id, { type: "noul", noul: 0.9 }]));
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage }), { status: 200 });
}

function mockFetch(responder: Responder = (_i, call) => okResponse(call)) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const call: Call = { url, body: JSON.parse(String(init.body)) as Call["body"] };
    calls.push(call);
    const r = await responder(calls.length - 1, call);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

type TestOptions = Partial<RunJevOptions> & {
  /** false なら、出力実績を作らない(最初の実行の制約を、そのまま受ける) */
  seedHistory?: boolean;
  /** 実績のリクエスト数(既定20。並列数を上げてよい最小値) */
  historyRequests?: number;
};

/**
 * 「同じ質問計画・variantの、課金済み完了実績」を、runs/ と index.json に作る。
 * 対象のデータと混ざらないよう、targetId は history-N、stateHash も固有の値にする(キャッシュには入れない)。
 * 実績は、mockFetch の既定の応答と同じ形(1リクエスト: 入力100・出力10トークン、費用0.2は最初のResultだけ)。
 */
function seedHistory(options: { questionIds?: string[]; isAck?: boolean; variant?: RunJevOptions["variant"]; requests?: number; split?: boolean }): void {
  const defs = loadQuestionDefs();
  const ids = options.questionIds;
  const selected = options.isAck
    ? [defs.isAck]
    : ids === undefined
      ? [...defs.aspects, ...defs.styles, ...defs.understandability]
      : defs.all.filter((d) => ids.includes(d.id));
  const variant = options.isAck ? "reply" : options.variant === "reply" ? "parent-only" : options.variant ?? "parent-only";
  const planHash = questionPlanHash(selected);
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8")));
  const requests = options.requests ?? 20;
  const groups = options.split ? selected.map((d) => [d]) : [selected];
  const results: Run["results"] = [];
  for (let i = 0; i < requests; i++) {
    for (const group of groups) {
      group.forEach((d, n) => {
        results.push({
          targetId: `history-${i}`, questionId: d.id, questionType: "noul", questionDefHash: questionDefHash(d),
          stateHash: sha256Hex(`history-state-${i}`), variant, raw: null, probability: 0.9, confidence: null, latencyMs: 0,
          usage: n === 0 ? { inputTokens: 100, outputTokens: 10 } : null, cost: n === 0 ? 0.2 : null, error: null,
        });
      });
    }
  }
  const runId = `history-${variant}-${planHash.slice(0, 8)}${options.split ? "-split" : ""}`;
  const run: Run = {
    schemaVersion: 1, runId, model: "jev-1.13.0", variant, stateConfig: {}, threadsSha256: manifest.threads.sha256,
    questionPlanHash: planHash, questionDefs: selected.map((d) => ({ id: d.id, hash: questionDefHash(d) })),
    createdAt: "2026-09-21T00:00:00Z", finishedAt: "2026-09-21T00:00:00Z", status: "complete", results,
  };
  const text = `${JSON.stringify(run, null, 2)}\n`;
  mkdirSync(join(dataDir, "runs"), { recursive: true });
  writeFileSync(join(dataDir, "runs", `${runId}.json`), text);
  const entry = { runId, status: "complete" as const, file: `runs/${runId}.json`, sha256: sha256Hex(text), createdAt: run.createdAt, variant };
  writeFileSync(join(dataDir, "index.json"), `${JSON.stringify({ ...manifest, runs: [...manifest.runs.filter((r) => r.runId !== runId), entry] }, null, 2)}\n`);
}

function opts(over: TestOptions = {}): RunJevOptions {
  const { seedHistory: withHistory = true, historyRequests, ...runOptions } = over;
  const base: RunJevOptions = {
    dataDir,
    pricingPath,
    mode: "all",
    variant: "parent-only",
    isAck: false,
    split: false,
    budget: 3.5,
    concurrency: 1,
    replyIsAckThreshold: 0.5,
    apiKey: API_KEY,
    sleep: async () => {},
    random: () => 0.5,
    now: () => NOW,
    log: () => {},
    ...runOptions,
  };
  if (withHistory && historyRequests !== 0) {
    seedHistory({ questionIds: base.questionIds, isAck: base.isAck, variant: base.variant, requests: historyRequests, split: base.split });
  }
  return base;
}

/** seedHistory が作った実績のrunか */
function isHistory(runId: string): boolean {
  return runId.startsWith("history-");
}

function readRun(runId: string): Run {
  return RunSchema.parse(JSON.parse(readFileSync(join(dataDir, "runs", `${runId}.json`), "utf8")));
}

function readLedger(): Record<string, unknown>[] {
  return readFileSync(join(dataDir, "ledger.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function allFileText(root: string): string {
  let text = "";
  for (const e of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) text += readFileSync(join(e.parentPath, e.name), "utf8");
  }
  return text;
}

async function ledgerTotals(limit = 3.5) {
  return (await Ledger.open(join(dataDir, "ledger.jsonl"), { limit })).totals();
}

describe("予算ガード: 費用はリクエスト単位で1回だけ", () => {
  it("16問を1リクエストで送ると、費用は1リクエスト分だけが台帳に確定され、最初のResultにだけ入る", async () => {
    seedThreads(1);
    const { fetch, calls } = mockFetch();
    const out = await runJev(opts({ fetch }));

    expect(calls.length).toBe(1);
    expect(Object.keys(calls[0]!.body.questions)).toEqual([
      "design-api", "types", "bug-edge-case", "compatibility-release", "tests",
      "readability-naming", "docs-comments", "security", "performance", "deps-build-tooling",
      "suggests-fix", "explains-reason", "question", "shares-context", "feature-request",
      "self-contained",
    ]);
    expect(out.kind).toBe("run");
    const run = readRun(out.runId);
    expect(run.status).toBe("complete");
    expect(run.model).toBe("jev-1.13.0");
    expect(run.results.length).toBe(16);
    expect(run.results.map((r) => r.cost)).toEqual([0.2, ...Array(15).fill(null)]);
    expect(run.results.map((r) => r.usage)).toEqual([{ inputTokens: 100, outputTokens: 10 }, ...Array(15).fill(null)]);
    const first = run.results[0]!;
    expect({ ...first, questionDefHash: "H", stateHash: "S", raw: "R" }).toEqual({
      targetId: "1000",
      questionId: "design-api",
      questionType: "noul",
      questionDefHash: "H",
      stateHash: "S",
      variant: "parent-only",
      raw: "R",
      probability: 0.9,
      confidence: null,
      latencyMs: 0,
      usage: { inputTokens: 100, outputTokens: 10 },
      cost: 0.2,
      error: null,
    });

    const ledger = readLedger();
    const id = ledger[0]!.requestId as string;
    // リクエストの同一性は、内容(state・質問定義・モデル)で決まる。runId は含めない
    expect(id.includes("@")).toBe(false);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const at = "2026-09-22T00:00:00.000Z";
    expect(ledger).toEqual([
      // 予約額は、実績から決まる: 出力10トークン/16問 × 安全率2 = 1問1.25トークン → 2トークンに切り上げ × 16問 × 0.02 = 0.64
      { schemaVersion: 1, at, event: "reserved", requestId: id, runId: out.runId, amount: 0.64 },
      { schemaVersion: 1, at, event: "sent", requestId: id },
      { schemaVersion: 1, at, event: "settled", requestId: id, cost: 0.2 },
    ]);
    expect(await ledgerTotals()).toEqual({ limit: 3.5, spent: 0.2, held: 0 });
  });

  it("--split では、質問ごとに別リクエストになり、それぞれの費用が1回ずつ確定される", async () => {
    seedThreads(1);
    const { fetch, calls } = mockFetch();
    const out = await runJev(opts({ fetch, split: true, questionIds: ["design-api", "types", "tests"] }));
    expect(calls.map((c) => Object.keys(c.body.questions))).toEqual([["design-api"], ["types"], ["tests"]]);
    const run = readRun(out.runId);
    expect(run.results.map((r) => [r.questionId, r.cost])).toEqual([
      ["design-api", 0.2],
      ["types", 0.2],
      ["tests", 0.2],
    ]);
    expect((await ledgerTotals()).spent).toBeCloseTo(0.6, 10);
    expect(readLedger().filter((e) => e.event === "settled").length).toBe(3);
  });
});

describe("予算ガード: 上限", () => {
  it("上限を超えそうなときは、送信せずに停止し、理由を保存する", async () => {
    seedThreads(3);
    const { fetch, calls } = mockFetch();
    // 実績(出力10トークン)から、1リクエストの予約額は 10 × 2(安全率) × 0.02 = 0.4。実費は0.2
    const out = await runJev(opts({ fetch, budget: 0.5, questionIds: ["design-api"] }));

    expect(calls.length).toBe(1);
    expect(out.kind).toBe("run");
    if (out.kind !== "run") return;
    expect(out.status).toBe("partial");
    expect(out.halted).toBe("予算上限を超えるため予約できません(確定 0.2 + 予約中 0 + 今回 0.4 > 上限 0.5)");
    const run = readRun(out.runId);
    expect(run.status).toBe("partial");
    expect(run.results.map((r) => ({ t: r.targetId, q: r.questionId, p: r.probability, e: r.error }))).toEqual([
      { t: "1000", q: "design-api", p: 0.9, e: null },
      {
        t: "1010",
        q: "design-api",
        p: null,
        e: {
          kind: "retryable",
          message: "予算上限を超えるため予約できません(確定 0.2 + 予約中 0 + 今回 0.4 > 上限 0.5)",
          attempts: 0,
          stopReason: "budget-limit",
        },
      },
    ]);
    expect(await ledgerTotals(0.5)).toEqual({ limit: 0.5, spent: 0.2, held: 0 });
  });

  it("並列3でも、確定費用と予約額の合計は上限を超えない", async () => {
    seedThreads(6);
    // 使用量の実績が無い最初のrunは並列数1になるため、先に実績を作る
    await runJev(opts({ fetch: mockFetch().fetch, mode: "limit", limit: 1, questionIds: ["design-api"] }));
    seedThreads(6, (i) => ({ bodyKey: `p-${i}` }));
    const { fetch, calls } = mockFetch();
    // 実績(出力10トークン)から、予約額は 10 × 2(安全率) × 0.02 = 0.4。上限 0.9 なら2件まで
    const out = await runJev(opts({ fetch, concurrency: 3, budget: 1.1, maxCostPerRequest: undefined, questionIds: ["design-api"] }));
    expect(out.kind).toBe("run");
    expect(calls.length).toBe(2);
    expect(await ledgerTotals(1.1)).toEqual({ limit: 1.1, spent: 0.2 + 0.4, held: 0 });
  });

  it("実績が20件に満たないと、並列数は1に下げられ、実費が予約額の2倍でも、上限を超える前に停止する", async () => {
    seedThreads(6);
    let inFlight = 0;
    let maxInFlight = 0;
    const logs: string[] = [];
    const { fetch, calls } = mockFetch(async (_i, call) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      // 実費は、予約額(0.4)の2倍: 出力40トークン × 0.02 = 0.8
      return okResponse(call, { input_tokens: 100, output_tokens: 40 });
    });
    // 上限1.4。並列3のままなら、予約 0.4 × 3 が通り、実費 0.8 × 3 = 2.4 が上限を超えて支払われていた
    const out = await runJev(opts({ fetch, concurrency: 3, budget: 1.4, historyRequests: 19, questionIds: ["design-api"], log: (l) => logs.push(l) }));
    if (out.kind !== "run") throw new Error("run expected");

    expect(maxInFlight).toBe(1);
    expect(calls.length).toBe(1); // overrun を検出した時点で、それ以降は送らない
    expect(out.status).toBe("partial");
    expect(out.halted).toContain("overrun");
    expect(logs.join("\n")).toContain("並列数を 3 から 1 にします");
    expect(readLedger().filter((e) => e.event === "overrun")).toHaveLength(1);
    const totals = await ledgerTotals(1.4);
    expect(totals.spent).toBeCloseTo(0.8, 10);
    expect(totals.spent).toBeLessThanOrEqual(1.4);
    expect(totals.held).toBe(0);
    expect(readRun(out.runId).results.filter((r) => r.error === null)).toHaveLength(1);
  });

  it("並列3が許された後(実績20件・overrunなし)でも、overrun が起きたら、それ以降の送信を止める(最悪でも並列数の分だけ)", async () => {
    seedThreads(6);
    // 3件が出そろうまで応答を返さない(3件とも予約済みで、実費が確定する前に送信されていることを保証する)
    let arrived = 0;
    let openBarrier!: () => void;
    const barrier = new Promise<void>((r) => (openBarrier = r));
    const { fetch, calls } = mockFetch(async (_i, call) => {
      if (++arrived === 3) openBarrier();
      await barrier;
      return okResponse(call, { input_tokens: 100, output_tokens: 40 }); // 実費0.8 > 予約額0.4
    });
    const out = await runJev(opts({ fetch, concurrency: 3, budget: 1.4, historyRequests: 20, questionIds: ["design-api"] }));
    if (out.kind !== "run") throw new Error("run expected");
    expect(calls.length).toBe(3); // 6件のうち、それ以降の送信は止まる
    expect(out.status).toBe("partial");
    expect(out.halted).toContain("overrun");
    expect(readLedger().filter((e) => e.event === "overrun").length).toBeGreaterThanOrEqual(1);
    expect(readRun(out.runId).results).toHaveLength(3);
  });
});

describe("予約額はリクエストの大きさに応じて大きくなる", () => {
  it("大きい state は、大きい予約額(入力単価があるとき)", async () => {
    writeFileSync(pricingPath, JSON.stringify({ schemaVersion: 1, inputUsdPerToken: 0.0001, outputUsdPerToken: 0.02 }));
    seedThreads(1);
    await runJev(opts({ fetch: mockFetch().fetch, mode: "limit", limit: 1, questionIds: ["design-api"], maxCostPerRequest: 3 }));
    seedThreads(2, (i) => ({ bodyKey: i === 0 ? "s" : "L".repeat(5000) }));
    const out = await runJev(opts({ fetch: mockFetch().fetch, maxCostPerRequest: undefined, questionIds: ["design-api"], budget: 10 }));
    const amounts = readLedger()
      .filter((e) => e.event === "reserved" && e.runId === out.runId)
      .map((e) => e.amount as number);
    expect(amounts.length).toBe(2);
    expect(amounts[1]! - amounts[0]!).toBeGreaterThan(0.4); // 約5000バイト × 0.0001
  });
});

/** 送信の同時数を測る。4件を送るので、並列が許されていれば、最大3まで上がる。 */
async function measureConcurrency(over: TestOptions, before: () => void | Promise<void> = () => {}): Promise<{ maxInFlight: number; calls: number; logs: string[] }> {
  seedThreads(4);
  await before();
  let inFlight = 0;
  let maxInFlight = 0;
  const logs: string[] = [];
  const { fetch, calls } = mockFetch(async (_i, call) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return okResponse(call);
  });
  await runJev(opts({ fetch, concurrency: 3, questionIds: ["design-api"], log: (l) => logs.push(l), ...over }));
  return { maxInFlight, calls: calls.length, logs };
}

describe("並列数は、実績が積み上がるまで1に固定する", () => {
  it("実績が19リクエストのとき、--concurrency が3でも、同時に送るのは1件だけ(理由をログに出す)", async () => {
    const r = await measureConcurrency({ historyRequests: 19 });
    expect(r.calls).toBe(4);
    expect(r.maxInFlight).toBe(1);
    expect(r.logs).toContain("同じ質問計画・variant の完了実績が 19 件で20件未満のため、並列数を 3 から 1 にします");
  });

  it("実績が20リクエストで、overrunが無いときだけ、指定した3を許す", async () => {
    const r = await measureConcurrency({ historyRequests: 20 });
    expect(r.calls).toBe(4);
    expect(r.maxInFlight).toBe(3);
    expect(r.logs.some((l) => l.includes("並列数を"))).toBe(false);
  });

  it("実績が20リクエストあっても、overrunが1件でもあれば(解除した後でも)、1のまま", async () => {
    const r = await measureConcurrency({ historyRequests: 20, acknowledgeOverrun: true }, () => recordOverrunInLedger()); // 台帳の記録だけを作る
    expect(r.calls).toBe(4);
    expect(r.maxInFlight).toBe(1);
    expect(r.logs).toContain("overrun の実績があるため、並列数を 3 から 1 にします");
  });

  it("実績が無い最初の実行でも、並列数は1(理由をログに出す)。送信は1リクエストだけ", async () => {
    const r = await measureConcurrency({ historyRequests: 0, mode: "limit", limit: 1, maxCostPerRequest: 0.5 });
    expect(r.calls).toBe(1);
    expect(r.maxInFlight).toBe(1);
    expect(r.logs).toContain("同じ質問計画・variant の完了実績が 0 件で20件未満のため、並列数を 3 から 1 にします");
  });

  it("実績は、リクエスト数で数える(16問1リクエストは1件。Resultの数=16件ではない)", async () => {
    const r = await measureConcurrency({ historyRequests: 2, questionIds: undefined });
    expect(r.calls).toBe(4);
    expect(r.maxInFlight).toBe(1);
    expect(r.logs).toContain("同じ質問計画・variant の完了実績が 2 件で20件未満のため、並列数を 3 から 1 にします");
  });

  it("実績は、同じ質問計画・variantのものだけを数える(別の質問・別のvariantの20件は、数えない)", async () => {
    const r = await measureConcurrency({ seedHistory: false, mode: "limit", limit: 1, maxCostPerRequest: 0.5 }, () => {
      seedHistory({ questionIds: ["types"], requests: 25 });
      seedHistory({ questionIds: ["design-api"], variant: "with-replies", requests: 25 });
    });
    expect(r.maxInFlight).toBe(1);
    expect(r.logs.some((l) => l.includes("実績が 0 件で20件未満"))).toBe(true);
  });
});

/** 過去にoverrunを記録した台帳を作る(実費が予約額を超えた、という記録) */
async function recordOverrunInLedger(): Promise<void> {
  const ledger = await Ledger.open(join(dataDir, "ledger.jsonl"), { limit: 3.5 });
  await ledger.reserve("old-request", 0.1, "old-run");
  await ledger.markSent("old-request");
  await ledger.settle("old-request", 0.5);
  expect(ledger.overrunSeen()).toBe(true);
}

describe("出力実績が無い最初の実行は、1リクエスト・1質問に絞る", () => {
  async function expectRejected(over: TestOptions, message: string): Promise<void> {
    seedThreads(3);
    const { fetch, calls } = mockFetch();
    await expect(runJev(opts({ fetch, seedHistory: false, maxCostPerRequest: 0.5, ...over }))).rejects.toThrow(message);
    expect(calls.length).toBe(0);
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
    expect(existsSync(join(dataDir, "ledger.jsonl"))).toBe(false);
  }

  it("--limit 5(質問1つ)は、拒否される。理由を示す", async () => {
    await expectRejected({ mode: "limit", limit: 5, questionIds: ["design-api"] }, "出力実績が無い最初の実行は --limit 1 にしてください");
  });

  it("--limit 1 は通り、送信はちょうど1件・1質問だけ", async () => {
    seedThreads(3);
    const { fetch, calls } = mockFetch();
    const out = await runJev(opts({ fetch, seedHistory: false, maxCostPerRequest: 0.5, mode: "limit", limit: 1, questionIds: ["design-api"] }));
    expect(calls.length).toBe(1);
    expect(Object.keys(calls[0]!.body.questions)).toEqual(["design-api"]);
    expect(out.kind === "run" && out.sentRequests).toBe(1);
  });

  it("--questions の指定が無いと、拒否される(--limit 1 でも)", async () => {
    await expectRejected({ mode: "limit", limit: 1 }, "--questions で1つだけ指定してください");
  });

  it("--questions が2つ以上だと、拒否される", async () => {
    await expectRejected({ mode: "limit", limit: 1, questionIds: ["design-api", "types"] }, "--questions で1つだけ指定してください");
  });

  it("--all は、拒否される", async () => {
    await expectRejected({ mode: "all", questionIds: ["design-api"] }, "出力実績が無い最初の実行では --all は使えません");
  });

  it("--is-ack も同じ(--questions is_ack --limit 1 だけが通る)", async () => {
    await expectRejected({ mode: "limit", limit: 1, isAck: true, variant: "reply" }, "--questions で1つだけ指定してください");
    await expectRejected({ mode: "all", isAck: true, variant: "reply", questionIds: ["is_ack"] }, "--all は使えません");
    const { fetch, calls } = mockFetch();
    await runJev(opts({ fetch, seedHistory: false, maxCostPerRequest: 0.5, mode: "limit", limit: 1, isAck: true, variant: "reply", questionIds: ["is_ack"] }));
    expect(calls.length).toBe(1);
  });

  it("失敗しただけの実績(課金・出力の確認が無いもの)は、実績に数えない", async () => {
    seedThreads(3);
    const { fetch } = mockFetch(() => new Response("bad", { status: 400 }));
    await runJev(opts({ fetch, seedHistory: false, maxCostPerRequest: 0.5, mode: "limit", limit: 1, questionIds: ["design-api"] }));
    const again = mockFetch();
    await expect(runJev(opts({ fetch: again.fetch, seedHistory: false, maxCostPerRequest: 0.5, mode: "all", questionIds: ["design-api"] }))).rejects.toThrow("--all は使えません");
    expect(again.calls.length).toBe(0);
  });

  it("1リクエストの成功の実績が1件できれば、制約は外れる(ただし並列は1のまま)", async () => {
    seedThreads(3);
    const first = mockFetch();
    await runJev(opts({ fetch: first.fetch, seedHistory: false, maxCostPerRequest: 0.5, mode: "limit", limit: 1, questionIds: ["design-api"] }));
    const r = await measureConcurrency({ seedHistory: false, maxCostPerRequest: undefined, mode: "all" });
    expect(r.calls).toBe(3); // 1件目はキャッシュ済み
    expect(r.maxInFlight).toBe(1);
  });

  it("--dry-run は、実績が無くても使える(送信しない)", async () => {
    seedThreads(3);
    await expect(planDryRun(opts({ mode: "dry-run", apiKey: null, seedHistory: false, maxCostPerRequest: 0.5 }))).resolves.toBeDefined();
  });

  it("同じvariantで、別の質問(1問)の実績が1件あれば、質問セット(複数問)をまとめた初回実行も、制約が外れる(--max-cost-per-requestは必要)", async () => {
    // 実データでの試走で見つかった不具合の再現: 質問セット(16問)の完全一致だけで実績を数えると、
    // そのセットで送る限り、実績を作る手段が無く、永久に初回実行の制約(1問だけ)から抜け出せない。
    // 出力は無料なので、質問数が増えても出力コストは増えない。別の質問の実績が1件でもあれば、十分。
    seedThreads(3);
    const first = mockFetch();
    await runJev(opts({ fetch: first.fetch, seedHistory: false, maxCostPerRequest: 0.5, mode: "limit", limit: 1, questionIds: ["design-api"] }));

    const defs = loadQuestionDefs();
    const fullPlan = [...defs.aspects, ...defs.styles, ...defs.understandability]; // questionIds を指定しない、既定の質問セット(16問)
    const second = mockFetch();
    const out = await runJev(
      opts({ fetch: second.fetch, seedHistory: false, maxCostPerRequest: 0.5, mode: "limit", limit: 1 }),
    );
    expect(second.calls.length).toBe(1);
    // 1件目のrunで、同じ対象(1件目のスレッド)の design-api は、既に判定済み(キャッシュ済み)なので、
    // 2件目のリクエストには、残り15問だけが含まれる。
    expect(Object.keys(second.calls[0]!.body.questions).sort()).toEqual(
      fullPlan.map((d) => d.id).filter((id) => id !== "design-api").sort(),
    );
    expect(out.kind === "run" && out.sentRequests).toBe(1);
  });
});

describe("overrun の停止は、再起動後も維持され、明示的な解除で外れる", () => {
  it("overrunで止まった後、新しいrun(再起動)でも送らない。--acknowledge-overrun の後だけ送り、解除を台帳に残す", async () => {
    seedThreads(3);
    const a = mockFetch((_i, call) => okResponse(call, { input_tokens: 100, output_tokens: 40 })); // 実費0.8 > 予約額0.4
    const first = await runJev(opts({ fetch: a.fetch, questionIds: ["design-api"] }));
    expect(a.calls.length).toBe(1);
    expect(first.kind === "run" && first.halted).toContain("overrun");

    const b = mockFetch();
    const second = await runJev(opts({ fetch: b.fetch, questionIds: ["design-api"] }));
    expect(b.calls.length).toBe(0);
    if (second.kind !== "run") throw new Error("run expected");
    expect(second.status).toBe("partial");
    expect(second.halted).toBe("実費が予約額を超えた(overrun)ため、新しい送信を止めています");
    expect(readLedger().some((e) => e.event === "overrun_acknowledged")).toBe(false);

    const logs: string[] = [];
    const c = mockFetch();
    const third = await runJev(opts({ fetch: c.fetch, questionIds: ["design-api"], acknowledgeOverrun: true, log: (l) => logs.push(l) }));
    expect(c.calls.length).toBe(2); // 1件目は保存済み(キャッシュ)。残り2件を送る
    expect(third.kind === "run" && third.status).toBe("complete");
    expect(readLedger().filter((e) => e.event === "overrun_acknowledged")).toHaveLength(1);
    expect(logs.join("\n")).toContain("明示的に解除");
  });

  it("--acknowledge-overrun は、overrunが無いときは何も記録しない(ログも出さない)", async () => {
    seedThreads(1);
    const logs: string[] = [];
    await runJev(opts({ fetch: mockFetch().fetch, questionIds: ["design-api"], acknowledgeOverrun: true, log: (l) => logs.push(l) }));
    expect(readLedger().some((e) => e.event === "overrun_acknowledged")).toBe(false);
    expect(logs.join("\n")).not.toContain("解除");
  });
});

describe("raw と index.json の整合を、run の前に検証する", () => {
  it("rawが index.json の後で変わった(import-raw の途中で、rawだけ新しい)と、run も --dry-run も停止する", async () => {
    seedThreads(1);
    const rc = join(dataDir, "raw", "rc_example_repo.jsonl");
    writeFileSync(rc, `${readFileSync(rc, "utf8")}\n`);
    const { fetch, calls } = mockFetch();
    const expected = "raw/rc_example_repo.jsonl: sha256が index.json の sources と一致しません。もう一度 import-raw を実行してください";
    await expect(runJev(opts({ fetch, questionIds: ["design-api"] }))).rejects.toThrow(expected);
    await expect(planDryRun(opts({ mode: "dry-run", apiKey: null }))).rejects.toThrow(expected);
    expect(calls.length).toBe(0);
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
    expect(existsSync(join(dataDir, "ledger.jsonl"))).toBe(false);
  });
});

describe("予算ガード: 応答不明(sent のまま)は自動で再送しない", () => {
  async function leaveUnresolved() {
    seedThreads(1);
    const first = mockFetch(() => new Error("connection reset"));
    const out = await runJev(opts({ fetch: first.fetch, questionIds: ["design-api"] }));
    expect(first.calls.length).toBe(1); // 通信エラーは再送しない(二重課金の防止)
    return out;
  }

  it.each([
    ["通信エラー", () => new Error("connection reset")],
    ["HTTP 500", () => new Response("oops", { status: 500 })],
    ["HTTP 503", () => new Response("oops", { status: 503 })],
  ])("%s は、fetch が1回だけで、unknown として記録され、台帳に sent のまま残る(再送されない)", async (_n, make) => {
    seedThreads(2);
    const { fetch, calls } = mockFetch(make);
    const out = await runJev(opts({ fetch, questionIds: ["design-api"] }));
    if (out.kind !== "run") throw new Error("run expected");
    expect(calls.length).toBe(2); // 2件のリクエストが、それぞれ1回だけ
    expect(out.status).toBe("partial");
    expect(readRun(out.runId).results.map((r) => r.error?.kind)).toEqual(["unknown", "unknown"]);
    expect(readRun(out.runId).results.map((r) => r.error?.attempts)).toEqual([1, 1]);
    expect(out.unresolved.length).toBe(2);
    expect(readLedger().map((e) => e.event)).toEqual(["reserved", "sent", "reserved", "sent"]);
    expect(await ledgerTotals()).toEqual({ limit: 3.5, spent: 0, held: 0.8 }); // 予約額0.4 × 2件
  });

  it("429・529 は、再送される(応答を受けており、処理されていない)", async () => {
    seedThreads(1);
    const { fetch, calls } = mockFetch((i, call) => (i === 0 ? new Response("x", { status: 429 }) : i === 1 ? new Response("x", { status: 529 }) : okResponse(call)));
    const out = await runJev(opts({ fetch, questionIds: ["design-api"] }));
    expect(calls.length).toBe(3);
    expect(out.status).toBe("complete");
    expect(await ledgerTotals()).toEqual({ limit: 3.5, spent: 0.2, held: 0 });
  });

  it("過去のrunの応答不明が残っていると、--resolve なしの新しいrunは、(別の内容でも)送信せずに停止し、一覧を出す", async () => {
    await leaveUnresolved();
    seedThreads(2, (i) => ({ bodyKey: `other-${i}` })); // 応答不明のものとは別の内容
    const logs: string[] = [];
    const second = mockFetch();
    const out = await runJev(opts({ fetch: second.fetch, questionIds: ["design-api"], log: (l) => logs.push(l) }));
    if (out.kind !== "run") throw new Error("run expected");
    expect(second.calls.length).toBe(0);
    expect(out.status).toBe("partial");
    expect(out.halted).toContain("応答不明");
    expect(out.halted).toContain("--resolve retry|skip");
    expect(out.unresolved.length).toBe(1);
    expect(logs.join("\n")).toContain(out.unresolved[0]!.requestId);
    expect(readLedger().map((e) => e.event)).toEqual(["reserved", "sent"]);
  });

  it("--resolve skip は永続する: 次のrun(別の runId)でも、skip したリクエストは再送されない。--resolve retry を明示したときだけ再送する", async () => {
    await leaveUnresolved();
    const skipRun = mockFetch();
    const r2 = await runJev(opts({ fetch: skipRun.fetch, questionIds: ["design-api"], resolve: "skip" }));
    expect(skipRun.calls.length).toBe(0);

    const next = mockFetch();
    const r3 = await runJev(opts({ fetch: next.fetch, questionIds: ["design-api"] }));
    expect(next.calls.length).toBe(0);
    expect(r3.runId).not.toBe(r2.runId);
    if (r3.kind !== "run") throw new Error("run expected");
    expect(r3.status).toBe("partial");
    expect(readRun(r3.runId).results.map((r) => r.error?.stopReason)).toEqual(["skipped"]);

    const retry = mockFetch();
    const r4 = await runJev(opts({ fetch: retry.fetch, questionIds: ["design-api"], resolve: "retry" }));
    expect(retry.calls.length).toBe(1);
    expect(readRun(r4.runId).status).toBe("complete");
    expect(readLedger().map((e) => e.event)).toEqual(["reserved", "sent", "resolved", "resolved", "reserved", "sent", "settled"]);
  });

  it("確定済みのリクエストは、キャッシュが失われても、再送しない(二重課金の防止)", async () => {
    seedThreads(1);
    await runJev(opts({ fetch: mockFetch().fetch, questionIds: ["design-api"] }));
    rmSync(join(dataDir, "cache"), { recursive: true, force: true });
    const again = mockFetch();
    const out = await runJev(opts({ fetch: again.fetch, questionIds: ["design-api"] }));
    expect(again.calls.length).toBe(0);
    if (out.kind !== "run") throw new Error("run expected");
    expect(out.status).toBe("partial");
    expect(readRun(out.runId).results.map((r) => r.error?.stopReason)).toEqual(["already-billed"]);
  });

  it("resolve が無ければ、再送せず、保留として報告する", async () => {
    await leaveUnresolved();
    const second = mockFetch();
    const out = await runJev(opts({ fetch: second.fetch, questionIds: ["design-api"] }));
    expect(second.calls.length).toBe(0);
    if (out.kind !== "run") throw new Error("run expected");
    expect(out.status).toBe("partial");
    expect(out.withheld.length).toBe(1);
    expect(out.unresolved.length).toBe(1);
    expect(await ledgerTotals()).toEqual({ limit: 3.5, spent: 0, held: 0.4 });
  });

  it("--resolve retry で、はじめて再送する(予約額を使ったものとして数える)", async () => {
    await leaveUnresolved();
    const third = mockFetch();
    const out = await runJev(opts({ fetch: third.fetch, questionIds: ["design-api"], resolve: "retry" }));
    expect(third.calls.length).toBe(1);
    if (out.kind !== "run") throw new Error("run expected");
    expect(out.status).toBe("complete");
    const totals = await ledgerTotals();
    expect(totals.spent).toBeCloseTo(0.4 + 0.2, 10); // skip相当で使用済みにした予約額0.4 + 再送の実費0.2
    expect(totals.held).toBe(0);
    expect(readLedger().map((e) => e.event)).toEqual(["reserved", "sent", "resolved", "reserved", "sent", "settled"]);
  });

  it("--resolve skip では、再送しない(予約額は使ったものとして数える)", async () => {
    await leaveUnresolved();
    const third = mockFetch();
    const out = await runJev(opts({ fetch: third.fetch, questionIds: ["design-api"], resolve: "skip" }));
    expect(third.calls.length).toBe(0);
    if (out.kind !== "run") throw new Error("run expected");
    expect(out.status).toBe("partial");
    expect(out.unresolved).toEqual([]);
    expect(await ledgerTotals()).toEqual({ limit: 3.5, spent: 0.4, held: 0 });
  });
});

describe("キャッシュ", () => {
  it("同じ入力の別スレッドは送信せず、キャッシュから読み、targetIdを付け替える", async () => {
    seedThreads(2, () => ({ bodyKey: "same" }));
    const { fetch, calls } = mockFetch();
    const out = await runJev(opts({ fetch, questionIds: ["design-api"] }));
    expect(calls.length).toBe(1);
    const run = readRun(out.runId);
    expect(run.results.map((r) => [r.targetId, r.questionId, r.probability, r.cost, r.usage])).toEqual([
      ["1000", "design-api", 0.9, 0.2, { inputTokens: 100, outputTokens: 10 }],
      ["1010", "design-api", 0.9, null, null],
    ]);
    expect(await ledgerTotals()).toEqual({ limit: 3.5, spent: 0.2, held: 0 });
  });

  it("再実行(新しいrun)でも、保存済みは送信しない。本文を変えると別の入力として送信される", async () => {
    seedThreads(2);
    const a = mockFetch();
    await runJev(opts({ fetch: a.fetch }));
    expect(a.calls.length).toBe(2);

    const b = mockFetch();
    const out = await runJev(opts({ fetch: b.fetch }));
    expect(b.calls.length).toBe(0);
    expect(readRun(out.runId).status).toBe("complete");
    expect(readRun(out.runId).results.length).toBe(32);

    // 別の本文にすると、キャッシュは効かない
    seedThreads(2, (i) => ({ bodyKey: `changed-${i}` }));
    const c = mockFetch();
    await runJev(opts({ fetch: c.fetch }));
    expect(c.calls.length).toBe(2);
  });
});

describe("--dry-run", () => {
  it("Jev APIを一切呼ばず、台帳・runも作らない。キーも要らない", async () => {
    seedThreads(3);
    const { fetch, calls } = mockFetch();
    const plan = await planDryRun(opts({ fetch, mode: "dry-run", apiKey: null, maxCostPerRequest: 0.5, seedHistory: false }));
    expect(calls.length).toBe(0);
    expect(plan).toEqual({
      targets: 3,
      questions: 16,
      requests: 3,
      cachedRequests: 0,
      requestsToSend: 3,
      reservePerRequest: 0.5,
      estimatedCost: 1.5,
      note: "見積もりは --max-cost-per-request による上限です",
    });
    expect(existsSync(join(dataDir, "ledger.jsonl"))).toBe(false);
    expect(existsSync(join(dataDir, "runs"))).toBe(false);
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
  });

  it("--split と --limit を反映し、使用量が未確認で --max-cost-per-request が無ければ見積もりは null", async () => {
    seedThreads(3);
    const plan = await planDryRun(opts({ mode: "dry-run", apiKey: null, limit: 2, split: true, maxCostPerRequest: undefined, seedHistory: false }));
    expect(plan).toEqual({
      targets: 2,
      questions: 16,
      requests: 32,
      cachedRequests: 0,
      requestsToSend: 32,
      reservePerRequest: null,
      estimatedCost: null,
      note: "使用量が未確認のため見積もれません(--max-cost-per-request を指定してください)",
    });
  });
});

describe("単価・予約額のガード", () => {
  it("単価が無いとき、--limit の試走以外(全件)を拒否し、Jevを呼ばない", async () => {
    seedThreads(1);
    const { fetch, calls } = mockFetch();
    await expect(runJev(opts({ fetch, pricingPath: join(dir, "none.json"), mode: "all" }))).rejects.toThrow(
      "単価が未設定です(jev/pricing.json)。--limit の試走以外は実行できません。pricing.example.json を参考に作成してください",
    );
    expect(calls.length).toBe(0);
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
  });

  it("単価が無くても --limit の試走はできる。費用は不明(null)で、台帳には予約額を確定する", async () => {
    seedThreads(2);
    const { fetch, calls } = mockFetch();
    const out = await runJev(opts({ fetch, pricingPath: join(dir, "none.json"), mode: "limit", limit: 1, questionIds: ["design-api"], maxCostPerRequest: 0.5, seedHistory: false }));
    expect(calls.length).toBe(1);
    expect(readRun(out.runId).results.map((r) => [r.cost, r.usage])).toEqual([[null, { inputTokens: 100, outputTokens: 10 }]]);
    expect(await ledgerTotals()).toEqual({ limit: 3.5, spent: 0.5, held: 0 });
  });

  it("使用量が未確認の最初のrunでは、--max-cost-per-request が必須。送信せず、ロックも解放される", async () => {
    seedThreads(1);
    const { fetch, calls } = mockFetch();
    await expect(runJev(opts({ fetch, seedHistory: false, mode: "limit", limit: 1, questionIds: ["design-api"], maxCostPerRequest: undefined }))).rejects.toThrow(
      "使用量が未確認(または単価が未設定)のため、--max-cost-per-request が必須です(最初は --limit 1 --questions is_ack で試してください)",
    );
    expect(calls.length).toBe(0);
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
  });

  it("使用量が確認できた後は、過去の出力トークンの最大 × 安全率2 + リクエストの大きさ から予約額を決める(--max-cost-per-request 不要)。実費の2倍", async () => {
    seedThreads(2);
    const a = mockFetch();
    await runJev(opts({ fetch: a.fetch, mode: "limit", limit: 1 }));
    seedThreads(2, (i) => ({ bodyKey: `new-${i}` }));
    const b = mockFetch();
    const out = await runJev(opts({ fetch: b.fetch, maxCostPerRequest: undefined }));
    expect(b.calls.length).toBe(2);
    const ledger = readLedger().filter((e) => e.runId === out.runId);
    // 実績(16問で出力10トークン)の1問あたり 0.625 × 安全率2 → 2トークンに切り上げ × 16問 × 単価0.02(入力単価は0)
    expect(ledger.map((e) => e.amount)).toEqual([0.64, 0.64]);
  });

  it("APIキーが無ければ、実行を拒否する(キー名だけを示す)", async () => {
    seedThreads(1);
    const { fetch, calls } = mockFetch();
    await expect(runJev(opts({ fetch, apiKey: null }))).rejects.toThrow("JEV_API_KEY が見つかりません");
    expect(calls.length).toBe(0);
  });

  it("--observed-cost が負・NaN・非数なら、何もせずに拒否する", async () => {
    seedThreads(1);
    const { fetch, calls } = mockFetch();
    await expect(runJev(opts({ fetch, observedCost: -1 }))).rejects.toThrow("--observed-cost は有限で非負の数値にしてください: -1");
    await expect(runJev(opts({ fetch, observedCost: Number.NaN }))).rejects.toThrow("--observed-cost は有限で非負の数値にしてください: NaN");
    expect(calls.length).toBe(0);
  });
});

describe("ロックとSIGINT", () => {
  it("正常終了でロックが解放される", async () => {
    seedThreads(1);
    await runJev(opts({ fetch: mockFetch().fetch }));
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
  });

  it("ロックが取られている(生きているpid)と、二重起動を拒否し、他人のロックは消さない", async () => {
    seedThreads(1);
    const release = await acquireLock(dataDir, { pid: process.pid });
    const { fetch, calls } = mockFetch();
    await expect(runJev(opts({ fetch }))).rejects.toBeInstanceOf(LockHeldError);
    expect(calls.length).toBe(0);
    expect(existsSync(join(dataDir, ".lock"))).toBe(true);
    await release();
  });

  it("途中で例外になっても、ロックが解放される", async () => {
    seedThreads(1);
    const { fetch, calls } = mockFetch();
    // ロックを取った後に例外が起こる状況: 台帳が壊れている
    writeFileSync(join(dataDir, "ledger.jsonl"), "not json\n");
    await expect(runJev(opts({ fetch }))).rejects.toThrow("台帳の行がJSONとして読めません");
    expect(calls.length).toBe(0);
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
  });

  it("SIGINT(AbortSignal)で、保存済みの結果は残り、partialになり、ロックは解放され、再開できる", async () => {
    seedThreads(4);
    const ac = new AbortController();
    const a = mockFetch((i, call) => {
      if (i === 1) ac.abort(); // 2件目の応答の途中で中断が来る
      return okResponse(call);
    });
    const out = await runJev(opts({ fetch: a.fetch, signal: ac.signal, questionIds: ["design-api"] }));
    expect(a.calls.length).toBe(2); // 中断後は新しい送信をしない(送信済みの2件は結果を保存する)
    if (out.kind !== "run") throw new Error("run expected");
    expect(out.status).toBe("partial");
    expect(out.aborted).toBe(true);
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
    const run = readRun(out.runId);
    expect(run.status).toBe("partial");
    expect(run.results.map((r) => [r.targetId, r.probability])).toEqual([["1000", 0.9], ["1010", 0.9]]);
    const manifest = ManifestSchema.parse(JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8")));
    expect(manifest.runs.filter((r) => !isHistory(r.runId)).map((r) => [r.runId, r.status])).toEqual([[out.runId, "partial"]]);

    // 再開: 保存済みの2件は送信されない。残りの2件だけ送る
    const b = mockFetch();
    const resumed = await runJev(opts({ fetch: b.fetch, questionIds: ["design-api"] }));
    expect(b.calls.length).toBe(2);
    expect(readRun(resumed.runId).status).toBe("complete");
    expect(readRun(resumed.runId).results.map((r) => r.targetId)).toEqual(["1000", "1010", "1020", "1030"]);
    expect(await ledgerTotals()).toEqual({ limit: 3.5, spent: 0.2 * 4, held: 0 });
  });

  it("実際の SIGINT(process のシグナル)でも同じく、partialになり、ハンドラとロックが解放される", async () => {
    seedThreads(3);
    const before = process.listenerCount("SIGINT");
    const a = mockFetch((i, call) => {
      if (i === 0) process.emit("SIGINT");
      return okResponse(call);
    });
    const out = await runJev(opts({ fetch: a.fetch, questionIds: ["design-api"] }));
    expect(a.calls.length).toBe(1);
    if (out.kind !== "run") throw new Error("run expected");
    expect(out.status).toBe("partial");
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
  });
});

describe("部分失敗・run と Manifest の保存", () => {
  it("1件が4xxで失敗しても、他は保存され、失敗は課金なしで台帳に記録される", async () => {
    seedThreads(3);
    const { fetch, calls } = mockFetch((i, call) => (i === 1 ? new Response("bad input", { status: 422 }) : okResponse(call)));
    const out = await runJev(opts({ fetch, questionIds: ["design-api"] }));
    expect(calls.length).toBe(3);
    const run = readRun(out.runId);
    expect(run.status).toBe("partial");
    expect(run.results.map((r) => [r.targetId, r.probability, r.cost, r.error])).toEqual([
      ["1000", 0.9, 0.2, null],
      ["1010", null, null, { kind: "fatal", message: "HTTP 422", attempts: 1 }],
      ["1020", 0.9, 0.2, null],
    ]);
    expect(await ledgerTotals()).toEqual({ limit: 3.5, spent: 0.4, held: 0 });
    expect(readLedger().map((e) => e.event)).toEqual([
      "reserved", "sent", "settled", "reserved", "sent", "failed", "reserved", "sent", "settled",
    ]);
  });

  it("応答が契約に合わない(HTTP 200で不正)ときは、課金の可能性があるため、予約額を確定する", async () => {
    seedThreads(1);
    const { fetch } = mockFetch(() => new Response(JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: USAGE }), { status: 200 }));
    await runJev(opts({ fetch, questionIds: ["design-api"] }));
    expect(await ledgerTotals()).toEqual({ limit: 3.5, spent: 0.4, held: 0 }); // 課金の可能性があるため、予約額(0.4)を確定する
  });

  it("runを保存し、index.json の runs を更新する(sources・threads は保持、threadsSha256を記録)", async () => {
    seedThreads(1);
    const before = ManifestSchema.parse(JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8")));
    const out = await runJev(opts({ fetch: mockFetch().fetch, questionIds: ["design-api", "question"] }));
    const text = readFileSync(join(dataDir, "runs", `${out.runId}.json`), "utf8");
    const run = readRun(out.runId);
    const after = ManifestSchema.parse(JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8")));
    expect(out.runId).toBe("run-20260922T000000Z-parent-only");
    expect({ ...after, runs: after.runs.filter((r) => !isHistory(r.runId)) }).toEqual({
      ...before,
      runs: [
        {
          runId: "run-20260922T000000Z-parent-only",
          status: "complete",
          file: "runs/run-20260922T000000Z-parent-only.json",
          sha256: sha256Hex(text),
          createdAt: "2026-09-22T00:00:00Z",
          variant: "parent-only",
        },
      ],
    });
    expect(run.threadsSha256).toBe(before.threads.sha256);
    expect(run.createdAt).toBe("2026-09-22T00:00:00Z");
    expect(run.finishedAt).toBe("2026-09-22T00:00:00Z");
    expect(run.stateConfig).toEqual({});
    expect(run.questionDefs.map((d) => d.id)).toEqual(["design-api", "question"]);
  });

  it("同じ秒に2回runしても、runIdは重ならない", async () => {
    seedThreads(1);
    const a = await runJev(opts({ fetch: mockFetch().fetch, questionIds: ["design-api"] }));
    const b = await runJev(opts({ fetch: mockFetch().fetch, questionIds: ["design-api"] }));
    expect([a.runId, b.runId]).toEqual(["run-20260922T000000Z-parent-only", "run-20260922T000000Z-parent-only-2"]);
  });

  it("threads.jsonl がManifestのhashと違えば、停止する", async () => {
    seedThreads(1);
    writeFileSync(join(dataDir, "threads", "threads.jsonl"), "");
    await expect(runJev(opts({ fetch: mockFetch().fetch }))).rejects.toThrow("threads/threads.jsonl のsha256が index.json と一致しません");
  });

  it("--limit N は先頭N件だけを対象にする", async () => {
    seedThreads(5);
    const { fetch, calls } = mockFetch();
    const out = await runJev(opts({ fetch, mode: "limit", limit: 2, questionIds: ["design-api"] }));
    expect(calls.length).toBe(2);
    expect(readRun(out.runId).results.map((r) => r.targetId)).toEqual(["1000", "1010"]);
  });
});

describe("with-replies と is_ack", () => {
  it("--is-ack は、返信ごとに、variant reply で送る(bot・unknownの返信は対象外)", async () => {
    seedThreads(2);
    const { fetch, calls } = mockFetch();
    const out = await runJev(opts({ fetch, isAck: true, variant: "reply" }));
    expect(calls.map((c) => [Object.keys(c.body.questions), c.body.state])).toEqual([
      [["is_ack"], { thread: { root: { body: "root body 0", path: "src/a.ts" }, earlier: [] }, reply: { body: "reply body 0" } }],
      [["is_ack"], { thread: { root: { body: "root body 1", path: "src/a.ts" }, earlier: [] }, reply: { body: "reply body 1" } }],
    ]);
    const run = readRun(out.runId);
    expect(run.variant).toBe("reply");
    expect(run.results.map((r) => [r.targetId, r.questionId, r.variant, r.probability])).toEqual([
      ["1001", "is_ack", "reply", 0.9],
      ["1011", "is_ack", "reply", 0.9],
    ]);
  });

  it("with-replies は、is_ack が閾値以上の返信を除外し、閾値を stateHash と stateConfig に含める", async () => {
    seedThreads(2);
    await runJev(opts({ fetch: mockFetch().fetch, isAck: true, variant: "reply" })); // is_ack = 0.9

    const a = mockFetch();
    const runA = await runJev(opts({ fetch: a.fetch, variant: "with-replies", replyIsAckThreshold: 0.5, questionIds: ["design-api"] }));
    expect(a.calls.map((c) => c.body.state)).toEqual([
      { comment: { body: "root body 0", path: "src/a.ts" }, diffHunk: "@@ -1 +1 @@", pr: { title: "dummy PR 7" }, replies: [] },
      { comment: { body: "root body 1", path: "src/a.ts" }, diffHunk: "@@ -1 +1 @@", pr: { title: "dummy PR 7" }, replies: [] },
    ]);

    const b = mockFetch();
    const runB = await runJev(opts({ fetch: b.fetch, variant: "with-replies", replyIsAckThreshold: 0.95, questionIds: ["design-api"] }));
    expect(b.calls.map((c) => c.body.state)).toEqual([
      { comment: { body: "root body 0", path: "src/a.ts" }, diffHunk: "@@ -1 +1 @@", pr: { title: "dummy PR 7" }, replies: [{ body: "reply body 0" }] },
      { comment: { body: "root body 1", path: "src/a.ts" }, diffHunk: "@@ -1 +1 @@", pr: { title: "dummy PR 7" }, replies: [{ body: "reply body 1" }] },
    ]);
    const ra = readRun(runA.runId);
    const rb = readRun(runB.runId);
    expect(ra.stateConfig).toEqual({ replyIsAckThreshold: 0.5 });
    expect(rb.stateConfig).toEqual({ replyIsAckThreshold: 0.95 });
    expect(ra.results.map((r) => r.stateHash)).not.toEqual(rb.results.map((r) => r.stateHash));
  });

  it("with-replies で閾値(replyIsAckThreshold)が未指定なら、既定値を置かず、拒否する(送信0回・台帳もrunも作らない)", async () => {
    seedThreads(1);
    const { fetch, calls } = mockFetch();
    // 実績(runs/)を作らない: 拒否のとき、runも台帳も作られないことを見る
    await expect(
      runJev(opts({ fetch, variant: "with-replies", replyIsAckThreshold: undefined, questionIds: ["design-api"], seedHistory: false })),
    ).rejects.toThrow("--reply-is-ack-threshold");
    await expect(
      planDryRun(opts({ fetch, mode: "dry-run", apiKey: null, variant: "with-replies", replyIsAckThreshold: undefined, seedHistory: false })),
    ).rejects.toThrow("--reply-is-ack-threshold");
    expect(calls.length).toBe(0);
    expect(existsSync(join(dataDir, "ledger.jsonl"))).toBe(false);
    expect(existsSync(join(dataDir, "runs"))).toBe(false);
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
  });

  it("parent-only と is_ack では、閾値は不要", async () => {
    seedThreads(1);
    await expect(runJev(opts({ fetch: mockFetch().fetch, replyIsAckThreshold: undefined, questionIds: ["design-api"] }))).resolves.toBeDefined();
    await expect(runJev(opts({ fetch: mockFetch().fetch, replyIsAckThreshold: undefined, isAck: true, variant: "reply" }))).resolves.toBeDefined();
  });

  it("is_ack の結果が無い返信は除外の根拠が無いので残す", async () => {
    seedThreads(1);
    const { fetch, calls } = mockFetch();
    await runJev(opts({ fetch, variant: "with-replies", questionIds: ["design-api"] }));
    expect((calls[0]!.body.state as { replies: unknown }).replies).toEqual([{ body: "reply body 0" }]);
  });
});

describe("キーの保護", () => {
  it("ログ・保存物・エラーに、キーの値が出ない(サーバーがキーを反響しても伏せられる)", async () => {
    seedThreads(2);
    const logs: string[] = [];
    const { fetch } = mockFetch((i, call) =>
      i === 0 ? new Response(`invalid token ${API_KEY}`, { status: 401 }) : okResponse(call),
    );
    const out = await runJev(opts({ fetch, log: (l) => logs.push(l), questionIds: ["design-api"] }));
    expect(out.kind).toBe("run");
    expect(allFileText(dataDir).includes(API_KEY)).toBe(false);
    expect(logs.join("\n").includes(API_KEY)).toBe(false);
    expect(readRun(out.runId).results[0]!.error).toEqual({ kind: "fatal", message: "HTTP 401", attempts: 1 });
  });

  it("APIキーが、応答・例外に、エンコードされて含まれても、保存物(run・キャッシュ・台帳)にもログにも出ない", async () => {
    seedThreads(3);
    const b64 = Buffer.from(API_KEY).toString("base64");
    const logs: string[] = [];
    const { fetch } = mockFetch((i, call) => {
      if (i === 0) return new Error(`connect failed ${API_KEY} ${encodeURIComponent(API_KEY)}`);
      if (i === 1) return new Response(JSON.stringify({ error: b64, key: API_KEY }), { status: 500 });
      const answers = Object.fromEntries(Object.keys(call.body.questions).map((id) => [id, { type: "noul", noul: 0.9 }]));
      return new Response(JSON.stringify({ model: `jev-${API_KEY}`, answers, usage: USAGE }), { status: 200 });
    });
    await runJev(opts({ fetch, log: (l) => logs.push(l), questionIds: ["design-api"] }));
    for (const dir of ["runs", "cache"]) expect(allFileText(join(dataDir, dir)).includes(API_KEY)).toBe(false);
    for (const secret of [API_KEY, b64, encodeURIComponent(API_KEY)]) {
      expect(allFileText(join(dataDir, "runs")).includes(secret)).toBe(false);
      expect(readFileSync(join(dataDir, "ledger.jsonl"), "utf8").includes(secret)).toBe(false);
      expect(allFileText(join(dataDir, "cache")).includes(secret)).toBe(false);
      expect(logs.join("\n").includes(secret)).toBe(false);
    }
  });

  it("APIが state(他人のコメント本文)をエコーしたエラー本文・応答を返しても、保存物(run・キャッシュ・台帳)に残らない", async () => {
    seedThreads(3);
    const { fetch } = mockFetch((i, call) => {
      const echoed = JSON.stringify(call.body.state);
      if (i === 0) return new Response(echoed, { status: 422 });
      if (i === 1) return new Response(echoed, { status: 500 });
      const answers = Object.fromEntries(
        Object.keys(call.body.questions).map((id) => [id, { type: "noul", noul: 0.9, explanation: echoed }]),
      );
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: USAGE, echoed_state: call.body.state }), { status: 200 });
    });
    await runJev(opts({ fetch, questionIds: ["design-api"] }));
    for (const dir of ["runs", "cache"]) expect(allFileText(join(dataDir, dir)).includes("root body")).toBe(false);
    expect(readFileSync(join(dataDir, "ledger.jsonl"), "utf8").includes("root body")).toBe(false);
    expect(readdirSync(join(dataDir, "cache")).length).toBe(1); // 成功した1件だけがキャッシュされている
  });

  describe("loadApiKey", () => {
    it(".claude/doc/.env とルートの .env の両方を探し、無ければ null", () => {
      const root = join(dir, "repo");
      mkdirSync(join(root, ".claude", "doc"), { recursive: true });
      expect(loadApiKey(root)).toBe(null);
      writeFileSync(join(root, ".env"), `OTHER=1\nJEV_API_KEY=${API_KEY}\n`);
      expect(loadApiKey(root)).toBe(API_KEY);
      writeFileSync(join(root, ".claude", "doc", ".env"), "JEV_API_KEY=from-doc-not-real\n");
      expect(loadApiKey(root)).toBe("from-doc-not-real");
    });

    it("空のキーは無いものとして扱う", () => {
      const root = join(dir, "repo2");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, ".env"), "JEV_API_KEY=\n");
      expect(loadApiKey(root)).toBe(null);
    });
  });
});

describe("report", () => {
  it("使用量・費用・応答時間を、リクエスト単位で集計し、--observed-cost との差を出す", async () => {
    seedThreads(2);
    const { fetch } = mockFetch((i, call) => (i === 1 ? new Response("bad", { status: 400 }) : okResponse(call)));
    const out = await runJev(opts({ fetch, questionIds: ["design-api", "types"], observedCost: 0.75 }));
    const report = await buildReport(dataDir, out.runId);
    expect(report).toEqual([
      {
        runId: out.runId,
        status: "partial",
        variant: "parent-only",
        model: "jev-1.13.0",
        results: 4,
        errors: 2,
        requests: 1,
        inputTokens: 100,
        outputTokens: 10,
        cost: 0.2,
        avgLatencyMs: 0,
        observed: { cost: 0.75, requests: 1, diff: 0.55 },
      },
    ]);
    expect(formatReport(report)).toBe(
      [
        `${out.runId}  partial  parent-only  jev-1.13.0`,
        "  結果 4 件(失敗 2 件) / リクエスト 1 件",
        "  トークン: 入力 100 / 出力 10",
        "  費用(計算): 0.2 ドル",
        "  応答時間(平均): 0 ms",
        "  実測費用: 0.75 ドル / 差(実測 - 計算): 0.55 ドル",
      ].join("\n"),
    );
  });

  it("16問1リクエストでも、費用・トークンは1リクエスト分だけ数える(16倍にしない)", async () => {
    seedThreads(1);
    const out = await runJev(opts({ fetch: mockFetch().fetch }));
    const [r] = await buildReport(dataDir, out.runId);
    expect([r!.results, r!.requests, r!.inputTokens, r!.outputTokens, r!.cost]).toEqual([16, 1, 100, 10, 0.2]);
  });

  it("--observed-cost に負・NaNは拒否する。同じrunに複数回記録したら、新しい値を使う", async () => {
    seedThreads(1);
    const out = await runJev(opts({ fetch: mockFetch().fetch, questionIds: ["design-api"] }));
    await expect(recordObservedCost(dataDir, { runId: out.runId, requests: 1, observedCost: -0.1, at: "2026-09-22T00:00:00Z" })).rejects.toThrow(
      "--observed-cost は有限で非負の数値にしてください: -0.1",
    );
    await recordObservedCost(dataDir, { runId: out.runId, requests: 1, observedCost: 0.3, at: "2026-09-22T00:00:00Z" });
    await recordObservedCost(dataDir, { runId: out.runId, requests: 1, observedCost: 0.25, at: "2026-09-22T00:01:00Z" });
    const [r] = await buildReport(dataDir, out.runId);
    expect(r!.observed).toEqual({ cost: 0.25, requests: 1, diff: 0.05 });
  });

  it("存在しないrunIdは、エラーにする", async () => {
    seedThreads(1);
    await expect(buildReport(dataDir, "run-none")).rejects.toThrow("run-none は index.json にありません");
  });
});
