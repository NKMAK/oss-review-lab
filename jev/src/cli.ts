import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseObservedCost } from "./cost";
import { resolveDataDir } from "./import-raw";
import { buildReport, formatReport, recordObservedCost } from "./report";
import { loadApiKey, planDryRun, runJev } from "./run";
import type { DryRunPlan, RunJevOptions } from "./run";

const USAGE = [
  "使い方:",
  "  run --dry-run | --limit N | --all  [--variant parent-only|with-replies] [--is-ack] [--split]",
  "      [--budget 3.5] [--concurrency 1] [--questions id,id] [--max-cost-per-request 0.5]",
  "      [--resolve retry|skip] [--observed-cost 0.02] [--reply-is-ack-threshold <0-1>(with-replies では必須)]",
  "  report [--run <runId>] [--observed-cost <額>]",
].join("\n");

export type CliEnv = { dataDir: string; pricingPath: string };

export type ParsedCommand =
  | { command: "run"; options: Omit<RunJevOptions, "apiKey"> }
  | { command: "report"; dataDir: string; runId: string | undefined; observedCost: number | undefined };

function num(name: string, text: string, kind: "positive-int" | "non-negative" | "positive"): number {
  const n = text.trim() === "" ? Number.NaN : Number(text);
  if (kind === "positive-int" && !(Number.isInteger(n) && n >= 1)) throw new Error(`${name} は1以上の整数にしてください: ${text}`);
  if (kind === "non-negative" && !(Number.isFinite(n) && n >= 0)) throw new Error(`${name} は有限で非負の数値にしてください: ${text}`);
  if (kind === "positive" && !(Number.isFinite(n) && n > 0)) throw new Error(`${name} は有限で正の数値にしてください: ${text}`);
  return n;
}

/** 引数を解釈する(副作用なし)。不正なら、理由つきで例外にする。 */
export function parseCommand(argv: string[], env: CliEnv): ParsedCommand {
  const [command, ...rest] = argv;
  if (command === "report") {
    const { values } = parseArgs({
      args: rest,
      options: { run: { type: "string" }, "observed-cost": { type: "string" } },
      strict: true,
    });
    const observed = values["observed-cost"];
    return {
      command: "report",
      dataDir: env.dataDir,
      runId: values.run,
      observedCost: observed === undefined ? undefined : parseObservedCost(observed),
    };
  }
  if (command !== "run") throw new Error(USAGE);

  const { values } = parseArgs({
    args: rest,
    options: {
      "dry-run": { type: "boolean" },
      limit: { type: "string" },
      all: { type: "boolean" },
      variant: { type: "string" },
      "is-ack": { type: "boolean" },
      split: { type: "boolean" },
      budget: { type: "string" },
      concurrency: { type: "string" },
      questions: { type: "string" },
      "max-cost-per-request": { type: "string" },
      resolve: { type: "string" },
      "observed-cost": { type: "string" },
      "reply-is-ack-threshold": { type: "string" },
    },
    strict: true,
  });

  if (values.all === true && values.limit !== undefined) throw new Error("--all と --limit は同時に指定できません");
  const mode: RunJevOptions["mode"] | null =
    values["dry-run"] === true ? "dry-run" : values.limit !== undefined ? "limit" : values.all === true ? "all" : null;
  if (mode === null) throw new Error("--dry-run、--limit N、--all のどれかを指定してください");

  const variant = values.variant ?? "parent-only";
  if (variant !== "parent-only" && variant !== "with-replies") {
    throw new Error(`--variant は parent-only か with-replies にしてください: ${variant}`);
  }
  if (values.resolve !== undefined && values.resolve !== "retry" && values.resolve !== "skip") {
    throw new Error(`--resolve は retry か skip にしてください: ${values.resolve}`);
  }
  const threshold = values["reply-is-ack-threshold"];
  // 閾値は、目視で決める値。既定値を置かず、with-replies(返信の除外を使う)のときは必須
  if (variant === "with-replies" && values["is-ack"] !== true && threshold === undefined) {
    throw new Error(
      "--variant with-replies では --reply-is-ack-threshold が必須です(既定値はありません。除外確認画面で、目視で決めた値を指定してください)",
    );
  }

  return {
    command: "run",
    options: {
      dataDir: env.dataDir,
      pricingPath: env.pricingPath,
      mode,
      limit: values.limit === undefined ? undefined : num("--limit", values.limit, "positive-int"),
      variant,
      isAck: values["is-ack"] === true,
      split: values.split === true,
      budget: values.budget === undefined ? 3.5 : num("--budget", values.budget, "non-negative"),
      // 安全側の既定: 並列数1。予約額が実費の上限になっていると確かめてから、明示して増やす
      concurrency: values.concurrency === undefined ? 1 : num("--concurrency", values.concurrency, "positive-int"),
      questionIds: values.questions === undefined ? undefined : values.questions.split(",").map((s) => s.trim()).filter((s) => s !== ""),
      maxCostPerRequest:
        values["max-cost-per-request"] === undefined ? undefined : num("--max-cost-per-request", values["max-cost-per-request"], "positive"),
      resolve: values.resolve,
      observedCost: values["observed-cost"] === undefined ? undefined : parseObservedCost(values["observed-cost"]),
      replyIsAckThreshold: threshold === undefined ? undefined : num("--reply-is-ack-threshold", threshold, "non-negative"),
    },
  };
}

export function formatDryRun(plan: DryRunPlan): string {
  const usd = (n: number | null): string => (n === null ? "不明" : `${n} ドル`);
  return [
    "[dry-run] Jev APIは呼びません",
    `対象: ${plan.targets} 件 / 質問: ${plan.questions} 問`,
    `リクエスト: ${plan.requests} 件(キャッシュ済み ${plan.cachedRequests} 件、送信 ${plan.requestsToSend} 件)`,
    `1リクエストあたりの予約額: ${usd(plan.reservePerRequest)}`,
    `見積もり費用: ${usd(plan.estimatedCost)}`,
    `注: ${plan.note}`,
  ].join("\n");
}

const JEV_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main(argv: string[]): Promise<void> {
  const parsed = parseCommand(argv, { dataDir: resolveDataDir(), pricingPath: join(JEV_DIR, "pricing.json") });
  if (parsed.command === "report") {
    let reports = await buildReport(parsed.dataDir, parsed.runId);
    if (parsed.observedCost !== undefined) {
      const target = reports.at(-1);
      if (target === undefined) throw new Error("記録先のrunがありません");
      await recordObservedCost(parsed.dataDir, {
        runId: target.runId,
        requests: target.requests,
        observedCost: parsed.observedCost,
        at: `${new Date().toISOString().slice(0, 19)}Z`,
      });
      reports = await buildReport(parsed.dataDir, target.runId);
    }
    console.log(formatReport(reports));
    return;
  }

  const options = parsed.options;
  if (options.mode === "dry-run") {
    console.log(formatDryRun(await planDryRun({ ...options, apiKey: null })));
    return;
  }
  const apiKey = loadApiKey(resolve(JEV_DIR, ".."));
  const outcome = await runJev({ ...options, apiKey, log: (line) => console.log(line) });
  if (outcome.halted !== null) console.log(`停止しました: ${outcome.halted}`);
  if (outcome.unresolved.length > 0) {
    console.log(`応答不明(sent のまま)のリクエスト: ${outcome.unresolved.length} 件。--resolve retry|skip で処理してください`);
    for (const u of outcome.unresolved) console.log(`  ${u.requestId}(run ${u.runId}、予約額 ${u.amount} ドル)`);
  }
  if (outcome.aborted) console.log("中断されました。同じコマンドで再実行すると、保存済みの結果を使って続きから進みます");
  if (outcome.withheld.length > 0) {
    console.log(`応答不明のため再送を保留したリクエスト: ${outcome.withheld.length} 件(--resolve retry|skip で処理してください)`);
  }
  console.log(`台帳: 確定 ${outcome.totals.spent} / 予約中 ${outcome.totals.held} / 上限 ${outcome.totals.limit} ドル`);
  if (outcome.status !== "complete") process.exitCode = 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
