import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { ManifestSchema, RunSchema, ThreadSchema } from "@oss-review-lab/shared";
import type { Manifest, Result, Run, Thread } from "@oss-review-lab/shared";
import { atomicWriteFile, atomicWriteJson } from "./atomic-write";
import { ResultCache, contentHash } from "./cache";
import { assertPricingForMode, computeCost, estimateReserve, loadPricing, parseObservedCost } from "./cost";
import type { OutputHistory } from "./cost";
import { sha256Hex, readIndexFile, verifyRawSources } from "./import-raw";
import { buildRequestBody, callJev } from "./jev-client";
import type { JevFetch, JevQuestion } from "./jev-client";
import { Ledger, acquireLock } from "./ledger";
import type { LedgerTotals, UnknownRequest } from "./ledger";
import { redactSecrets } from "./redact";
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
  /** overrun による停止を理解した人が、明示的に解除する */
  acknowledgeOverrun?: boolean;
  observedCost?: number;
  /** with-replies のとき必須(既定値を置かない。目視で決める値) */
  replyIsAckThreshold?: number;
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
  const base = [...all.aspects, ...all.styles, ...all.understandability];
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
  if (o.variant === "with-replies" && !o.isAck && o.replyIsAckThreshold === undefined) {
    throw new Error(
      "with-replies では --reply-is-ack-threshold が必須です(既定値はありません。除外確認画面で、目視で決めた値を指定してください)",
    );
  }
}

function prepare(o: RunJevOptions): Prepared {
  verifyRawSources(o.dataDir);
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
    const threshold = o.replyIsAckThreshold!; // validateOptions で必須にしている
    stateConfig = { replyIsAckThreshold: threshold };
    const ack: Record<string, number> = {};
    for (const entry of manifest.runs) {
      if (entry.variant !== "reply" || !existsSync(join(o.dataDir, entry.file))) continue;
      for (const r of readRunFile(o.dataDir, entry).results) {
        if (r.questionId === "is_ack" && r.error === null && r.probability !== null) ack[r.targetId] = r.probability;
      }
    }
    units = targets.map((t) => {
      const b = buildWithRepliesState(t, ack, threshold);
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

function completedRequestsOf(dataDir: string, p: Prepared): number {
  let count = 0;
  for (const entry of p.manifest.runs) {
    if (!existsSync(join(dataDir, entry.file))) continue;
    const run = readRunFile(dataDir, entry);
    if (run.variant !== p.variant || run.questionPlanHash !== p.planHash) continue;
    count += run.results.filter((result) => result.error === null && result.usage !== null).length;
  }
  return count;
}

/**
 * この variant で、同じ質問計画とは限らず、完了した実績が1件でもあるか。
 * 「初回1問縛り」を外すための判定で、completedRequestsOf(質問計画ごとの厳格な一致)とは別にする。
 *
 * 質問セット(質問計画)が違うたびに、そのセットの実績が0件になるので、質問計画の完全一致だけで判定すると、
 * 複数の質問をまとめた計画(例: 15問セット)を、永久に初回実行できなくなる(そのセットで送る限り、
 * 実績を作る手段が無い)。出力トークンは無料([discussion/jev-budget-staged-run.md]と、2026-09-22に
 * 公式ドキュメント https://docs.typesafe.ai/models.md で確認)なので、質問数が増えても出力コストは
 * 増えない。そのため、同じvariantで、どんな質問セットでもよいので、一度でも実際の応答を確認できていれば、
 * 「初回1問縛り」は外してよい(入力費用は、リクエストの大きさから、毎回、独立に見積もる)。
 */
function anyCompletedRequestsOf(dataDir: string, p: Prepared): number {
  let count = 0;
  for (const entry of p.manifest.runs) {
    if (!existsSync(join(dataDir, entry.file))) continue;
    const run = readRunFile(dataDir, entry);
    if (run.variant !== p.variant) continue;
    count += run.results.filter((result) => result.error === null && result.usage !== null).length;
  }
  return count;
}

/** 出力実績が無い(このvariantで、まだ1件も成功していない)ときは、推定予約額を上限と誤認しないよう、試走を1件・1問に絞る。 */
function assertFirstExecutionGuard(o: RunJevOptions, p: Prepared, anyCompletedRequests: number): void {
  if (anyCompletedRequests > 0) return;
  if (o.mode === "all") throw new Error("出力実績が無い最初の実行では --all は使えません。--limit 1 --questions <id> で試走してください");
  if (o.mode !== "limit" || o.limit !== 1) {
    throw new Error("出力実績が無い最初の実行は --limit 1 にしてください(1リクエストだけ送信します)");
  }
  if (o.questionIds === undefined || o.questionIds.length !== 1 || p.defs.length !== 1) {
    throw new Error("出力実績が無い最初の実行は --questions で1つだけ指定してください");
  }
}

/**
 * 同じ形(variant・質問計画)のrunの実績から、1質問あたりの出力トークンの最大を求める。無ければ null(初回)。
 * 1リクエストに含まれる質問の数は、(同じ targetId の Result の数) / (そのうち usage を持つ Result の数) で近似する
 * (通常のrunは質問数、--split は 1)。
 */
function outputHistoryOf(dataDir: string, p: Prepared): OutputHistory | null {
  let max: number | null = null;
  for (const entry of p.manifest.runs) {
    if (!existsSync(join(dataDir, entry.file))) continue;
    const run = readRunFile(dataDir, entry);
    if (run.variant !== p.variant || run.questionPlanHash !== p.planHash) continue;
    const perTarget = new Map<string, { results: number; requests: number }>();
    for (const r of run.results) {
      const c = perTarget.get(r.targetId) ?? { results: 0, requests: 0 };
      c.results++;
      if (r.usage !== null) c.requests++;
      perTarget.set(r.targetId, c);
    }
    for (const r of run.results) {
      if (r.usage === null) continue;
      const c = perTarget.get(r.targetId)!;
      const perQuestion = r.usage.outputTokens / (c.results / c.requests);
      max = max === null ? perQuestion : Math.max(max, perQuestion);
    }
  }
  return max === null ? null : { maxOutputTokensPerQuestion: max };
}

/** キャッシュ検索に使うモデル識別子(直近の成功したrunのもの)。未知なら null(ミス扱い)。 */
function knownModelOf(dataDir: string, p: Prepared): string | null {
  return findRecentRun(dataDir, p.manifest, (r) => r.results.some((x) => x.error === null))?.model ?? null;
}

/**
 * リクエストの同一性 = 内容(正規化済みstateのhash + 質問定義のhash + モデル)。台帳のリクエストIDに使う。
 * runId を含めないので、別のrunでも同じリクエストとして扱える(skip・確定済みを引き継ぐ)。
 */
function requestContentKey(p: Prepared, item: Item, questionIds: string[], model: string): string {
  return contentHash([p.variant, item.unit.stateHash, questionIds.map((id) => [id, p.defHash.get(id)]), model]).slice(0, 32);
}

function questionsOf(p: Prepared, ids: string[]): JevQuestion[] {
  return ids.map((id) => {
    const d = p.defs.find((x) => x.id === id)!;
    return { id, type: d.type, instructions: d.instructions, criteria: d.criteria };
  });
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
  // dry-runは、何も送信しない(課金が発生しない)ので、実行時の「初回1問縛り」は確認しない。
  // 見積もりの数字が、実際に送るときには拒否される場合があることは、note で示す(下)。
  const cache = new ResultCache(join(o.dataDir, "cache"));
  const model = knownModelOf(o.dataDir, p);
  const pricing = await loadPricing(o.pricingPath);
  const history = outputHistoryOf(o.dataDir, p);
  const requestedModel = o.model ?? DEFAULT_MODEL;
  let cached = 0;
  let requestsToSend = 0;
  let reserveMax: number | null = null;
  let estimated = 0;
  let unknown = false;
  for (const item of p.items) {
    const { missing } = await lookup(cache, p, item, model);
    if (missing.length === 0) {
      cached++;
      continue;
    }
    requestsToSend++;
    try {
      const body = buildRequestBody(item.unit.state, requestedModel, questionsOf(p, missing));
      const d = estimateReserve({ requestBody: body, questionCount: missing.length, history, pricing, maxCostPerRequest: o.maxCostPerRequest });
      if (d.ok) {
        reserveMax = Math.max(reserveMax ?? 0, d.amount);
        estimated += d.amount;
      }
    } catch (e) {
      if (o.maxCostPerRequest !== undefined) throw e; // 不正な値は、見積もりでも知らせる
      unknown = true;
    }
  }
  return {
    targets: p.units.length,
    questions: p.defs.length,
    requests: p.items.length,
    cachedRequests: cached,
    requestsToSend,
    reservePerRequest: unknown ? null : reserveMax,
    estimatedCost: unknown ? null : estimated,
    note: unknown
      ? "使用量が未確認のため見積もれません(--max-cost-per-request を指定してください)"
      : history === null || pricing === null
        ? "見積もりは --max-cost-per-request による上限です"
        : "見積もりは、リクエストの大きさと、直近のrunの出力トークンの実績による上限です",
  };
}

type Failure = "billed-unknown" | "not-billed" | "uncertain";

/**
 * 失敗したリクエストの、課金の扱い。応答の有無で分ける。
 * - unknown(応答不明): 課金されたかもしれない。台帳に sent のまま残す(自動では再送しない)
 * - 429・529・4xx(状態コードだけのメッセージ): 処理されていない。課金なし
 * - それ以外(2xxなのに契約に合わない応答など): 課金された可能性があり、使用量も不明。予約額を確定する
 */
function classifyFailure(error: NonNullable<Result["error"]>): Failure {
  if (error.kind === "unknown") return "uncertain";
  if (error.kind === "retryable" || /^HTTP \d{3}$/.test(error.message)) return "not-billed";
  return "billed-unknown";
}

export async function runJev(o: RunJevOptions): Promise<RunOutcome> {
  if (o.mode === "dry-run") throw new Error("dry-run は planDryRun を使ってください");
  validateOptions(o);
  const now = o.now ?? (() => new Date());
  const pricing = await loadPricing(o.pricingPath);
  assertPricingForMode(o.mode, pricing);
  if (o.apiKey === null || o.apiKey === "") {
    throw new Error(`${KEY_NAME} が見つかりません(.claude/doc/.env かリポジトリ直下の .env に設定してください)`);
  }
  const apiKey = o.apiKey;
  // ログにも、キーを出さない(共通のマスク関数を通す)
  const log = (line: string): void => o.log?.(redactSecrets(line, apiKey));
  const p = prepare(o);
  const initialCompletedRequests = completedRequestsOf(o.dataDir, p);
  assertFirstExecutionGuard(o, p, anyCompletedRequestsOf(o.dataDir, p));
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
    const ledger = await Ledger.open(join(o.dataDir, "ledger.jsonl"), { limit: o.budget, now, warn: log });
    const cache = new ResultCache(join(o.dataDir, "cache"));

    // 起動時の回復: 未送信の予約は解放。応答不明(sent)は、--resolve が指定されるまで、新しい送信を始めない。
    if (o.acknowledgeOverrun === true && (await ledger.acknowledgeOverrun())) {
      log("overrun の停止を明示的に解除しました。予約額は実費を保証しない見積もりです。並列数は1のままです");
    }
    const recovered = await ledger.recover();
    let blocked: string | null = null;
    if (o.resolve !== undefined) {
      for (const u of recovered.unresolved) {
        await ledger.resolve(u.requestId, o.resolve);
        log(`応答不明のリクエスト ${u.requestId} を ${o.resolve} で処理しました(予約額 ${u.amount} を使用済みとして数えます)`);
      }
    } else if (recovered.unresolved.length > 0) {
      for (const u of recovered.unresolved) {
        log(`応答不明のリクエスト ${u.requestId}(run ${u.runId}、予約額 ${u.amount})があります。再送しません`);
      }
      blocked = `応答不明のリクエストが ${recovered.unresolved.length} 件あります。--resolve retry|skip を指定するまで、新しい送信は始めません: ${recovered.unresolved.map((u) => u.requestId).join(", ")}`;
    }

    const history = outputHistoryOf(o.dataDir, p);
    const completedRequests = initialCompletedRequests;
    // 予約額の見積もりに必要な条件(初回は --max-cost-per-request が必須。不正な値もここで拒否)を、送信の前に確かめる
    estimateReserve({ requestBody: "", questionCount: 1, history, pricing, maxCostPerRequest: o.maxCostPerRequest });
    // 出力トークンの実績が無い最初の試走は、並列数1(予約額が実費の上限になる保証が、最も弱いため)
    let concurrency = o.concurrency;
    if (concurrency > 1 && (completedRequests < 20 || ledger.overrunEverSeen())) {
      const reason = ledger.overrunEverSeen()
        ? "overrun の実績があるため"
        : `同じ質問計画・variant の完了実績が ${completedRequests} 件で20件未満のため`;
      log(`${reason}、並列数を ${concurrency} から 1 にします`);
      concurrency = 1;
    }

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
    if (blocked !== null) halted = blocked;
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
        // 停止中は送らない。ただし、応答不明で止めているときは、send が保留として数える(一覧を出すため)
        if (missing.length > 0 && !abort.signal.aborted && (halted === null || blocked !== null)) {
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
      const requestId = requestContentKey(p, item, missing, requestedModel);
      const stop = (error: NonNullable<Result["error"]>): void => {
        for (const id of missing) out.set(id, errorResult(item, id, error));
      };

      // 台帳の状態で、送ってよいかを決める(リクエストの同一性は内容。別のrunでも引き継ぐ)
      const status = ledger.statusOf(requestId);
      if (status === "settled") {
        // 確定済み(課金済み)なのに、キャッシュに無い。再送すると二重課金になるので、送らない
        stop({ kind: "fatal", message: "already settled in the ledger but missing from the cache; not re-sent to avoid double billing", attempts: 0, stopReason: "already-billed" });
        return;
      }
      if (status === "skipped") {
        if (o.resolve === "retry") await ledger.resolve(requestId, "retry");
        else {
          stop({ kind: "fatal", message: "skipped by --resolve skip (use --resolve retry to send it again)", attempts: 0, stopReason: "skipped" });
          return;
        }
      }
      if (status === "sent" || status === "reserved" || blocked !== null) {
        withheld.push({ contentKey: requestId });
        stop({ kind: "retryable", message: "withheld: an earlier request with unknown outcome is unresolved", attempts: 0, stopReason: "unresolved-unknown" });
        return;
      }

      const questions = questionsOf(p, missing);
      const decision = estimateReserve({
        requestBody: buildRequestBody(item.unit.state, requestedModel, questions),
        questionCount: missing.length,
        history,
        pricing,
        maxCostPerRequest: o.maxCostPerRequest,
      });
      if (!decision.ok) {
        // 予約額が実費の上限として成り立たない(またはこのリクエストだけ --max-cost-per-request を超える)。送らない
        stop({ kind: "fatal", message: decision.reason, attempts: 0, stopReason: "reserve-exceeds-cap" });
        return;
      }
      const amount = decision.amount;
      const reserved = await ledger.reserve(requestId, amount, runId);
      if (!reserved.ok) {
        halted ??= reserved.reason;
        stop({ kind: "retryable", message: reserved.reason, attempts: 0, stopReason: "budget-limit" });
        return;
      }
      await ledger.markSent(requestId);
      sentRequests++;
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
        const { overrun } = await ledger.settle(requestId, cost ?? amount);
        if (overrun) {
          // 実費が予約額を超えた。台帳に記録済み。直ちに新しい送信を止める(実行中の分は、待つ)
          halted ??= `実費(${cost})が予約額(${amount})を超えました(overrun)。予約額が実費の上限になっていないため、新しい送信を止めます`;
          log(halted);
        }
        for (const r of results) out.set(r.questionId, r);
      } else {
        for (const r of outcome.results) out.set(r.questionId, r);
        const kind = classifyFailure(first.error);
        if (kind === "not-billed") await ledger.fail(requestId, first.error.message, 0);
        else if (kind === "billed-unknown") await ledger.fail(requestId, first.error.message, amount);
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
        const run: Run = RunSchema.parse(redactSecrets({
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
        }, apiKey));
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
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(p.items.length, 1)) }, worker));
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
