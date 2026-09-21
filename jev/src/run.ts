import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { ManifestSchema, RunSchema, ThreadSchema } from "@oss-review-lab/shared";
import type { Manifest, Result, Run, Thread } from "@oss-review-lab/shared";
import { atomicWriteFile, atomicWriteJson } from "./atomic-write";
import { ResultCache, contentHash } from "./cache";
import { assertPricingForMode, computeCost, decideReserveAmount, loadPricing, parseObservedCost } from "./cost";
import type { Pricing, Usage } from "./cost";
import { sha256Hex, readIndexFile } from "./import-raw";
import { callJev } from "./jev-client";
import type { JevFetch, JevQuestion } from "./jev-client";
import { Ledger, acquireLock } from "./ledger";
import type { LedgerTotals, UnknownRequest } from "./ledger";
import { loadQuestionDefs, buildRequests, questionDefHash, questionPlanHash } from "./questions";
import type { QuestionDef } from "./questions";
import { recordObservedCost, countRequests } from "./report";
import { buildIsAckState, buildParentOnlyState, buildWithRepliesState, selectAckTargets, selectTargetThreads } from "./state";

export type RunMode = "dry-run" | "limit" | "all";

export type RunJevOptions = {
  dataDir: string;
  pricingPath: string;
  questionsDir?: string;
  mode: RunMode;
  /** mode が limit のとき必須(対象の先頭N件) */
  limit?: number;
  variant: "parent-only" | "with-replies" | "reply";
  /** 返信の is_ack を判定する(variant は reply になる) */
  isAck: boolean;
  split: boolean;
  /** 台帳の上限(ドル) */
  budget: number;
  concurrency: number;
  questionIds?: string[];
  maxCostPerRequest?: number;
  resolve?: "retry" | "skip";
  observedCost?: number;
  replyIsAckThreshold: number;
  /** 読み込みは loadApiKey。ログ・保存物には出さない */
  apiKey: string | null;
  /** 送るモデル指定(既定 jev-latest) */
  model?: string;
  // 外部境界の注入
  fetch?: JevFetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  signal?: AbortSignal;
  log?: (line: string) => void;
};

export type DryRunPlan = {
  targets: number;
  questions: number;
  requests: number;
  cachedRequests: number;
  requestsToSend: number;
  reservePerRequest: number | null;
  estimatedCost: number | null;
  note: string;
};

export type RunOutcome = {
  kind: "run";
  runId: string;
  status: Run["status"];
  /** 予算上限で停止したときの理由 */
  halted: string | null;
  aborted: boolean;
  /** 応答不明のため、再送を保留したリクエスト */
  withheld: { contentKey: string }[];
  /** 台帳に残っている、応答不明のリクエスト(--resolve が必要) */
  unresolved: UnknownRequest[];
  sentRequests: number;
  totals: LedgerTotals;
};

const KEY_NAME = "JEV_API_KEY";
const DEFAULT_MODEL = "jev-latest";
const PERSIST_EVERY = 25;

/**
 * `.claude/doc/.env` と、リポジトリ直下の `.env` から JEV_API_KEY を探す(前者を優先)。
 * 値は、この関数の戻り値以外には、どこにも出さない(例外にも含めない)。
 */
export function loadApiKey(repoRoot: string): string | null {
  for (const path of [join(repoRoot, ".claude", "doc", ".env"), join(repoRoot, ".env")]) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`${path}: 読めません(${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
    const value = parseDotenv(text)[KEY_NAME];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return null;
}

/** 秒単位のISO 8601(UTC, 末尾Z)。 */
function iso(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

type Unit = { targetId: string; state: unknown; stateHash: string };
type Item = { unit: Unit; questionIds: string[] };

type Prepared = {
  manifest: Manifest;
  threadsSha256: string;
  variant: Run["variant"];
  defs: QuestionDef[];
  defHash: Map<string, string>;
  planHash: string;
  units: Unit[];
  items: Item[];
  stateConfig: Run["stateConfig"];
};

function readManifest(dataDir: string): Manifest {
  const raw = readIndexFile(dataDir);
  if (raw === null) throw new Error(`${join(dataDir, "index.json")} がありません。先に import-raw と build-threads を実行してください`);
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`index.json が不正です(先に build-threads を実行してください): ${parsed.error.message}`);
  }
  return parsed.data;
}

function readThreads(dataDir: string, manifest: Manifest): { threads: Thread[]; sha256: string } {
  const file = manifest.threads.file;
  const text = readFileSync(join(dataDir, file), "utf8");
  const sha256 = sha256Hex(text);
  if (sha256 !== manifest.threads.sha256) {
    throw new Error(`${file} のsha256が index.json と一致しません(build-threads をやり直してください)`);
  }
  const threads = text
    .split("\n")
    .filter((l) => l !== "")
    .map((l, i) => {
      try {
        return ThreadSchema.parse(JSON.parse(l));
      } catch (e) {
        throw new Error(`${file}:${i + 1}: スレッドの形式が不正です: ${(e as Error).message}`);
      }
    });
  return { threads, sha256 };
}

function readRunFile(dataDir: string, entry: Manifest["runs"][number]): Run {
  const path = join(dataDir, entry.file);
  try {
    return RunSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    throw new Error(`${path}: runを読めません: ${(e as Error).message}`);
  }
}

/** 新しいrunから順に、条件に合う最初のものを返す。 */
function findRecentRun(dataDir: string, manifest: Manifest, pred: (run: Run) => boolean): Run | null {
  for (const entry of [...manifest.runs].reverse()) {
    if (!existsSync(join(dataDir, entry.file))) continue;
    const run = readRunFile(dataDir, entry);
    if (pred(run)) return run;
  }
  return null;
}

function selectQuestions(o: RunJevOptions, all: ReturnType<typeof loadQuestionDefs>): { defs: QuestionDef[]; ackMode: boolean } {
  const ids = o.questionIds;
  if (ids !== undefined) {
    const known = new Set(all.all.map((d) => d.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`未知の質問IDです: ${unknown.join(", ")}`);
  }
  const wantsAck = o.isAck || (ids !== undefined && ids.includes(all.isAck.id));
  if (wantsAck) {
    if (ids !== undefined && (ids.length !== 1 || ids[0] !== all.isAck.id)) {
      throw new Error("is_ack は返信への質問なので、親コメントへの質問とは同時に指定できません");
    }
    return { defs: [all.isAck], ackMode: true };
  }
  const base = [...all.aspects, ...all.styles];
  const defs = ids === undefined ? base : base.filter((d) => ids.includes(d.id));
  if (defs.length === 0) throw new Error("質問が1つもありません");
  return { defs, ackMode: false };
}

function validateOptions(o: RunJevOptions): void {
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1) throw new Error(`--concurrency は1以上の整数にしてください: ${String(o.concurrency)}`);
  if (!Number.isFinite(o.budget) || o.budget < 0) throw new Error(`--budget は有限で非負の数値にしてください: ${String(o.budget)}`);
  if (o.mode === "limit" && (o.limit === undefined || !Number.isInteger(o.limit) || o.limit < 1)) {
    throw new Error(`--limit は1以上の整数にしてください: ${String(o.limit)}`);
  }
  if (o.observedCost !== undefined) parseObservedCost(o.observedCost);
}

function prepare(o: RunJevOptions): Prepared {
  const manifest = readManifest(o.dataDir);
  const { threads, sha256: threadsSha256 } = readThreads(o.dataDir, manifest);
  const { defs, ackMode } = selectQuestions(o, loadQuestionDefs(o.questionsDir));
  const variant: Run["variant"] = ackMode ? "reply" : o.variant === "reply" ? "parent-only" : o.variant;
  const targets = selectTargetThreads(threads);

  let units: Unit[];
  let stateConfig: Run["stateConfig"] = {};
  if (ackMode) {
    units = targets.flatMap((t) =>
      selectAckTargets(t).map((reply) => {
        const b = buildIsAckState(t, reply.id);
        return { targetId: reply.id, state: b.state, stateHash: b.stateHash };
      }),
    );
  } else if (variant === "with-replies") {
    stateConfig = { replyIsAckThreshold: o.replyIsAckThreshold };
    const ack: Record<string, number> = {};
    for (const entry of manifest.runs) {
      if (entry.variant !== "reply" || !existsSync(join(o.dataDir, entry.file))) continue;
      for (const r of readRunFile(o.dataDir, entry).results) {
        if (r.questionId === "is_ack" && r.error === null && r.probability !== null) ack[r.targetId] = r.probability;
      }
    }
    units = targets.map((t) => {
      const b = buildWithRepliesState(t, ack, o.replyIsAckThreshold);
      return { targetId: t.threadId, state: b.state, stateHash: b.stateHash };
    });
  } else {
    units = targets.map((t) => {
      const b = buildParentOnlyState(t);
      return { targetId: t.threadId, state: b.state, stateHash: b.stateHash };
    });
  }
  if (o.limit !== undefined) units = units.slice(0, o.limit);

  const items: Item[] = units.flatMap((unit) =>
    buildRequests(unit.state, defs, o.split).map((req) => ({ unit, questionIds: req.questionIds })),
  );
  return {
    manifest,
    threadsSha256,
    variant,
    defs,
    defHash: new Map(defs.map((d) => [d.id, questionDefHash(d)])),
    planHash: questionPlanHash(defs),
    units,
    items,
    stateConfig,
  };
}

/** 直近の、同じ形(variant・質問計画)のrunの、1リクエストあたりの平均使用量。無ければ null。 */
function averageUsageOf(dataDir: string, p: Prepared): Usage | null {
  const run = findRecentRun(
    dataDir,
    p.manifest,
    (r) => r.variant === p.variant && r.questionPlanHash === p.planHash && r.results.some((x) => x.usage !== null),
  );
  if (run === null) return null;
  const usages = run.results.flatMap((r) => (r.usage === null ? [] : [r.usage]));
  return {
    inputTokens: usages.reduce((s, u) => s + u.inputTokens, 0) / usages.length,
    outputTokens: usages.reduce((s, u) => s + u.outputTokens, 0) / usages.length,
  };
}

/** キャッシュ検索に使うモデル識別子(直近の成功したrunのもの)。未知なら null(ミス扱い)。 */
function knownModelOf(dataDir: string, p: Prepared): string | null {
  return findRecentRun(dataDir, p.manifest, (r) => r.results.some((x) => x.error === null))?.model ?? null;
}

function requestContentKey(p: Prepared, item: Item, questionIds: string[]): string {
  return contentHash([p.variant, item.unit.stateHash, questionIds.map((id) => [id, p.defHash.get(id)])]).slice(0, 16);
}

async function lookup(
  cache: ResultCache,
  p: Prepared,
  item: Item,
  model: string | null,
): Promise<{ hits: Map<string, Result>; missing: string[] }> {
  const hits = new Map<string, Result>();
  const missing: string[] = [];
  for (const id of item.questionIds) {
    const hit =
      model === null
        ? null
        : await cache.get({ stateHash: item.unit.stateHash, questionDefHash: p.defHash.get(id)!, model });
    if (hit === null) missing.push(id);
    // キャッシュのキーに targetId は含まれない。付け替え、この実行では費用を発生させていないので cost・usage は空にする
    else hits.set(id, { ...hit, targetId: item.unit.targetId, cost: null, usage: null });
  }
  return { hits, missing };
}

export async function planDryRun(o: RunJevOptions): Promise<DryRunPlan> {
  validateOptions(o);
  const p = prepare(o);
  const cache = new ResultCache(join(o.dataDir, "cache"));
  const model = knownModelOf(o.dataDir, p);
  let cached = 0;
  for (const item of p.items) {
    if ((await lookup(cache, p, item, model)).missing.length === 0) cached++;
  }
  const requestsToSend = p.items.length - cached;
  const pricing = await loadPricing(o.pricingPath);
  let reserve: number | null = null;
  let note = "使用量が未確認のため見積もれません(--max-cost-per-request を指定してください)";
  try {
    reserve = decideReserveAmount({ maxCostPerRequest: o.maxCostPerRequest, averageUsage: averageUsageOf(o.dataDir, p), pricing });
    note = o.maxCostPerRequest !== undefined ? "見積もりは --max-cost-per-request による上限です" : "見積もりは直近のrunの平均使用量による";
  } catch (e) {
    if (o.maxCostPerRequest !== undefined) throw e; // 不正な値は、見積もりでも知らせる
  }
  return {
    targets: p.units.length,
    questions: p.defs.length,
    requests: p.items.length,
    cachedRequests: cached,
    requestsToSend,
    reservePerRequest: reserve,
    estimatedCost: reserve === null ? null : reserve * requestsToSend,
    note,
  };
}

type Failure = "billed-unknown" | "not-billed" | "uncertain";

/** 失敗したリクエストの、課金の扱い。応答の有無で分ける(応答不明は、台帳に sent のまま残す)。 */
function classifyFailure(message: string): Failure {
  if (/^HTTP \d{3}:/.test(message)) return "not-billed";
  if (/^(timeout after|network error)/.test(message)) return "uncertain";
  return "billed-unknown"; // 2xxだが契約に合わない応答など: 課金された可能性があり、使用量も不明
}

export async function runJev(o: RunJevOptions): Promise<RunOutcome> {
  if (o.mode === "dry-run") throw new Error("dry-run は planDryRun を使ってください");
  validateOptions(o);
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => new Date());
  const pricing = await loadPricing(o.pricingPath);
  assertPricingForMode(o.mode, pricing);
  if (o.apiKey === null || o.apiKey === "") {
    throw new Error(`${KEY_NAME} が見つかりません(.claude/doc/.env かリポジトリ直下の .env に設定してください)`);
  }
  const apiKey = o.apiKey;
  const p = prepare(o);
  const requestedModel = o.model ?? DEFAULT_MODEL;

  const abort = new AbortController();
  const onSigint = (): void => {
    if (!abort.signal.aborted) log("中断を受け付けました。実行中のリクエストの完了を待って、保存します");
    abort.abort();
  };
  const onExternal = (): void => abort.abort();
  process.on("SIGINT", onSigint);
  if (o.signal?.aborted) abort.abort();
  o.signal?.addEventListener("abort", onExternal);

  const release = await acquireLock(o.dataDir, { now }).catch((e: unknown) => {
    process.off("SIGINT", onSigint);
    o.signal?.removeEventListener("abort", onExternal);
    throw e;
  });
  try {
    return await execute();
  } finally {
    process.off("SIGINT", onSigint);
    o.signal?.removeEventListener("abort", onExternal);
    await release();
  }

  async function execute(): Promise<RunOutcome> {
    const ledger = await Ledger.open(join(o.dataDir, "ledger.jsonl"), { limit: o.budget, now });
    const cache = new ResultCache(join(o.dataDir, "cache"));

    // 起動時の回復: 未送信の予約は解放。応答不明(sent)は、--resolve が指定されるまで保留する。
    const recovered = await ledger.recover();
    const heldKeys = new Set<string>();
    const skipKeys = new Set<string>();
    const contentKeyOf = (requestId: string): string => requestId.split("@")[0]!;
    if (o.resolve !== undefined) {
      for (const u of recovered.unresolved) {
        await ledger.resolve(u.requestId, o.resolve);
        if (o.resolve === "skip") skipKeys.add(contentKeyOf(u.requestId));
        log(`応答不明のリクエスト ${u.requestId} を ${o.resolve} で処理しました(予約額 ${u.amount} を使用済みとして数えます)`);
      }
    } else {
      for (const u of recovered.unresolved) {
        heldKeys.add(contentKeyOf(u.requestId));
        log(`応答不明のリクエスト ${u.requestId}(予約額 ${u.amount})があります。再送しません。--resolve retry|skip で処理してください`);
      }
    }

    let reserveAmount = decideReserveAmount({
      maxCostPerRequest: o.maxCostPerRequest,
      averageUsage: averageUsageOf(o.dataDir, p),
      pricing,
    });

    // runId(同じ秒でも重ならない)
    const createdAt = iso(now());
    const stamp = createdAt.replace(/[-:]/g, "");
    const baseId = `run-${stamp}-${p.variant}${o.split ? "-split" : ""}`;
    let runId = baseId;
    for (let n = 2; existsSync(join(o.dataDir, "runs", `${runId}.json`)) || p.manifest.runs.some((r) => r.runId === runId); n++) {
      runId = `${baseId}-${n}`;
    }

    let knownModel = knownModelOf(o.dataDir, p);
    let actualModel: string | null = null;
    let halted: string | null = null;
    let sentRequests = 0;
    const withheld: { contentKey: string }[] = [];
    const slots: Result[][] = p.items.map(() => []);
    let expected = 0;
    for (const item of p.items) expected += item.questionIds.length;

    const gates = new Map<string, Promise<void>>();

    const errorResult = (item: Item, questionId: string, error: NonNullable<Result["error"]>): Result => ({
      targetId: item.unit.targetId,
      questionId,
      questionType: "noul",
      questionDefHash: p.defHash.get(questionId)!,
      stateHash: item.unit.stateHash,
      variant: p.variant,
      raw: null,
      probability: null,
      confidence: null,
      latencyMs: 0,
      usage: null,
      cost: null,
      error,
    });

    async function processItem(index: number): Promise<void> {
      const item = p.items[index]!;
      const gateKey = `${item.unit.stateHash}|${item.questionIds.join(",")}`;
      // 同じ入力が同時に送られないよう、先行するものの完了(キャッシュへの保存)を待つ
      const prior = gates.get(gateKey);
      let openGate!: () => void;
      if (prior !== undefined) await prior;
      else gates.set(gateKey, new Promise<void>((r) => (openGate = r)));
      try {
        const { hits, missing } = await lookup(cache, p, item, knownModel);
        const fresh = new Map<string, Result>();
        if (missing.length > 0 && !abort.signal.aborted && halted === null) {
          await send(item, missing, fresh);
        }
        slots[index] = item.questionIds.flatMap((id) => {
          const r = fresh.get(id) ?? hits.get(id);
          return r === undefined ? [] : [r];
        });
      } finally {
        openGate?.();
      }
    }

    async function send(item: Item, missing: string[], out: Map<string, Result>): Promise<void> {
      const contentKey = requestContentKey(p, item, missing);
      if (skipKeys.has(contentKey)) return;
      if (heldKeys.has(contentKey)) {
        withheld.push({ contentKey });
        return;
      }
      const requestId = `${contentKey}@${runId}`;
      const amount = reserveAmount;
      const reserved = await ledger.reserve(requestId, amount, runId);
      if (!reserved.ok) {
        halted ??= reserved.reason;
        for (const id of missing) {
          out.set(id, errorResult(item, id, { kind: "retryable", message: reserved.reason, attempts: 0, stopReason: "budget-limit" }));
        }
        return;
      }
      await ledger.markSent(requestId);
      sentRequests++;
      const questions: JevQuestion[] = missing.map((id) => {
        const d = p.defs.find((x) => x.id === id)!;
        return { id, type: d.type, instructions: d.instructions, criteria: d.criteria };
      });
      const outcome = await callJev({
        state: item.unit.state,
        questions,
        model: requestedModel,
        apiKey,
        meta: {
          targetId: item.unit.targetId,
          stateHash: item.unit.stateHash,
          variant: p.variant,
          questionDefHashes: Object.fromEntries(missing.map((id) => [id, p.defHash.get(id)!])),
        },
        fetch: o.fetch,
        sleep: o.sleep,
        random: o.random,
        now: () => now().getTime(),
      });
      if (outcome.model !== null) {
        actualModel = outcome.model;
        knownModel = outcome.model;
      }
      const first = outcome.results[0]!;
      if (first.error === null) {
        const usage = first.usage!;
        const cost = pricing === null ? null : computeCost(usage, pricing);
        // 費用は、リクエスト単位で1回だけ数える(全Resultに同じusageが入っているため、合算すると質問数倍になる)
        const results = outcome.results.map((r, i) => ({ ...r, cost: i === 0 ? cost : null, usage: i === 0 ? r.usage : null }));
        for (const r of results) await cache.put(outcome.model!, r);
        await ledger.settle(requestId, cost ?? amount);
        reserveAmount = Math.max(reserveAmount, cost ?? amount);
        for (const r of results) out.set(r.questionId, r);
      } else {
        for (const r of outcome.results) out.set(r.questionId, r);
        const kind = classifyFailure(first.error.message);
        if (kind === "not-billed") await ledger.fail(requestId, first.error.message, 0);
        else if (kind === "billed-unknown") {
          await ledger.fail(requestId, first.error.message, amount);
          reserveAmount = Math.max(reserveAmount, amount);
        }
        // uncertain: 台帳に sent のまま残す(応答不明。自動では再送しない)
      }
    }

    let done = 0;
    let persisting: Promise<void> = Promise.resolve();
    const collect = (): Result[] => slots.flat();
    const persist = (final: boolean): Promise<void> => {
      persisting = persisting.then(async () => {
        const results = collect();
        const ok = results.length === expected && results.every((r) => r.error === null);
        const complete = final && !abort.signal.aborted && halted === null && withheld.length === 0 && ok;
        const run: Run = RunSchema.parse({
          schemaVersion: 1,
          runId,
          model: actualModel ?? knownModel ?? requestedModel,
          variant: p.variant,
          stateConfig: p.stateConfig,
          threadsSha256: p.threadsSha256,
          questionPlanHash: p.planHash,
          questionDefs: p.defs.map((d) => ({ id: d.id, hash: p.defHash.get(d.id)! })),
          createdAt,
          finishedAt: final ? iso(now()) : null,
          status: complete ? "complete" : "partial",
          results,
        });
        const file = `runs/${runId}.json`;
        const text = `${JSON.stringify(run, null, 2)}\n`;
        await atomicWriteFile(join(o.dataDir, file), text);
        const current = readManifest(o.dataDir);
        const entry = { runId, status: run.status, file, sha256: sha256Hex(text), createdAt, variant: run.variant };
        const next = ManifestSchema.parse({
          ...current,
          runs: [...current.runs.filter((r) => r.runId !== runId), entry],
        });
        await atomicWriteJson(join(o.dataDir, "index.json"), next);
        finalRun = run;
      });
      return persisting;
    };
    let finalRun: Run | null = null;

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= p.items.length) return;
        await processItem(i);
        if (++done % PERSIST_EVERY === 0) await persist(false);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(o.concurrency, Math.max(p.items.length, 1)) }, worker));
    } catch (e) {
      // 予期しない失敗でも、保存済みの結果は残す(台帳は、送信済みなら sent のまま残る)
      await persist(true).catch(() => undefined);
      throw e;
    }
    await persist(true);
    const run = finalRun!;

    if (o.observedCost !== undefined) {
      await recordObservedCost(o.dataDir, { runId, requests: countRequests(run), observedCost: o.observedCost, at: iso(now()) });
    }
    log(`run ${runId}: ${run.status}(結果 ${run.results.length} 件、送信 ${sentRequests} リクエスト)`);
    return {
      kind: "run",
      runId,
      status: run.status,
      halted,
      aborted: abort.signal.aborted,
      withheld,
      unresolved: ledger.unresolved(),
      sentRequests,
      totals: ledger.totals(),
    };
  }
}
