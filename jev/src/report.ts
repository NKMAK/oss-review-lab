import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ManifestSchema, RunSchema } from "@oss-review-lab/shared";
import type { Run } from "@oss-review-lab/shared";
import { z } from "zod";
import { parseObservedCost } from "./cost";

const OBSERVED_FILE = "observed-costs.jsonl";

const ObservedSchema = z.object({
  schemaVersion: z.literal(1),
  at: z.string(),
  runId: z.string(),
  /** そのrunで送ったリクエスト数(記録時点) */
  requests: z.number().int().min(0),
  /** ダッシュボードの残高の差から、ユーザーが読み取った額(ドル) */
  observedCost: z.number().min(0),
});

export type ObservedCostInput = { runId: string; requests: number; observedCost: number; at: string };

/** リクエスト数(応答を受けた、新規のリクエスト)。usage は、リクエストの最初の Result にだけ入っている。 */
export function countRequests(run: Run): number {
  return run.results.filter((r) => r.usage !== null).length;
}

/** `--observed-cost` を、runIdとリクエスト数と一緒に、`data/observed-costs.jsonl` へ追記する。 */
export async function recordObservedCost(dataDir: string, input: ObservedCostInput): Promise<void> {
  const observedCost = parseObservedCost(input.observedCost);
  await mkdir(dataDir, { recursive: true });
  const entry = { schemaVersion: 1, at: input.at, runId: input.runId, requests: input.requests, observedCost };
  await appendFile(join(dataDir, OBSERVED_FILE), `${JSON.stringify(entry)}\n`);
}

export type RunReport = {
  runId: string;
  status: Run["status"];
  variant: Run["variant"];
  model: string;
  results: number;
  errors: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** 単価が未設定で費用を計算できなかったら null */
  cost: number | null;
  avgLatencyMs: number | null;
  observed: { cost: number; requests: number; diff: number | null } | null;
};

const round = (n: number): number => Math.round(n * 1e9) / 1e9;

async function readObserved(dataDir: string): Promise<Map<string, z.infer<typeof ObservedSchema>>> {
  let text = "";
  try {
    text = await readFile(join(dataDir, OBSERVED_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const latest = new Map<string, z.infer<typeof ObservedSchema>>();
  for (const [i, line] of text.split("\n").entries()) {
    if (line === "") continue;
    const parsed = ObservedSchema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`${OBSERVED_FILE}:${i + 1}: 形式が不正です: ${parsed.error.message}`);
    latest.set(parsed.data.runId, parsed.data);
  }
  return latest;
}

/**
 * 使用量・費用・応答時間の集計(リクエスト単位。質問ごとの Result を合算しない)と、`--observed-cost` との差。
 * runId を省略すると、全runを古い順に返す。
 */
export async function buildReport(dataDir: string, runId?: string): Promise<RunReport[]> {
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(dataDir, "index.json"), "utf8")));
  const entries = runId === undefined ? manifest.runs : manifest.runs.filter((r) => r.runId === runId);
  if (runId !== undefined && entries.length === 0) throw new Error(`${runId} は index.json にありません`);
  const observed = await readObserved(dataDir);

  const reports: RunReport[] = [];
  for (const entry of entries) {
    const run = RunSchema.parse(JSON.parse(await readFile(join(dataDir, entry.file), "utf8")));
    const perRequest = run.results.filter((r) => r.usage !== null);
    const costs = run.results.flatMap((r) => (r.cost === null ? [] : [r.cost]));
    const cost = costs.length === 0 ? null : round(costs.reduce((s, c) => s + c, 0));
    const obs = observed.get(run.runId);
    reports.push({
      runId: run.runId,
      status: run.status,
      variant: run.variant,
      model: run.model,
      results: run.results.length,
      errors: run.results.filter((r) => r.error !== null).length,
      requests: perRequest.length,
      inputTokens: perRequest.reduce((s, r) => s + r.usage!.inputTokens, 0),
      outputTokens: perRequest.reduce((s, r) => s + r.usage!.outputTokens, 0),
      cost,
      avgLatencyMs: perRequest.length === 0 ? null : round(perRequest.reduce((s, r) => s + r.latencyMs, 0) / perRequest.length),
      observed:
        obs === undefined
          ? null
          : { cost: obs.observedCost, requests: obs.requests, diff: cost === null ? null : round(obs.observedCost - cost) },
    });
  }
  return reports;
}

export function formatReport(reports: RunReport[]): string {
  return reports
    .map((r) => {
      const lines = [
        `${r.runId}  ${r.status}  ${r.variant}  ${r.model}`,
        `  結果 ${r.results} 件(失敗 ${r.errors} 件) / リクエスト ${r.requests} 件`,
        `  トークン: 入力 ${r.inputTokens} / 出力 ${r.outputTokens}`,
        `  費用(計算): ${r.cost === null ? "不明(単価が未設定、または費用の記録なし)" : `${r.cost} ドル`}`,
        `  応答時間(平均): ${r.avgLatencyMs === null ? "-" : `${r.avgLatencyMs} ms`}`,
      ];
      if (r.observed !== null) {
        lines.push(
          `  実測費用: ${r.observed.cost} ドル / 差(実測 - 計算): ${r.observed.diff === null ? "計算不能" : `${r.observed.diff} ドル`}`,
        );
      }
      return lines.join("\n");
    })
    .join("\n\n");
}
