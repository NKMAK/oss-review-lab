import type { Result } from "@oss-review-lab/shared";

export const BIN_COUNT = 10;

export type QuestionDistribution = {
  questionId: string;
  questionType: Result["questionType"];
  /** 確率の分布に入れた件数(エラーの Result は含めない) */
  count: number;
  /** この質問のエラー(`error` が入っている Result)の件数 */
  errorCount: number;
  /** 確率の10区間(0.1刻み)の件数。1.0 は最後の区間に入れる */
  bins: number[];
  /** choice / score だけが持つ。noul は常に null */
  meanConfidence: number | null;
};

export type Aggregate = {
  resultCount: number;
  errorCount: number;
  questionCount: number;
  questions: QuestionDistribution[];
  latency: { count: number; minMs: number; meanMs: number; medianMs: number; maxMs: number } | null;
  billing: { requestCount: number; totalCost: number; inputTokens: number; outputTokens: number };
};

/** 浮動小数点の足し算の誤差(0.1 + 0.2 など)を、表示に出さないための丸め */
function roundCost(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

function binIndex(p: number): number {
  return Math.min(BIN_COUNT - 1, Math.floor(p * BIN_COUNT + 1e-9));
}

function median(sortedAsc: number[]): number {
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 1
    ? (sortedAsc[mid] as number)
    : ((sortedAsc[mid - 1] as number) + (sortedAsc[mid] as number)) / 2;
}

/**
 * Run の Result を、確率の分布・応答時間・使用量と費用に集計する。
 *
 * 費用・使用量の注意: 1リクエストが複数の Result を返す。`cost` は、リクエストの最初の Result にだけ入り(他は null)、
 * `usage` と `latencyMs` は、同じリクエストの全 Result に重複して入りうる。なので、Result ごとに足すと二重計上になる。
 * `cost` が入っている Result を「リクエストの先頭」として数え、費用・トークン・応答時間は、その Result だけから集計する。
 */
export function aggregateResults(results: readonly Result[]): Aggregate {
  const byQuestion = new Map<string, QuestionDistribution & { confidenceSum: number; confidenceCount: number }>();
  let errorCount = 0;

  for (const r of results) {
    let q = byQuestion.get(r.questionId);
    if (q === undefined) {
      q = {
        questionId: r.questionId,
        questionType: r.questionType,
        count: 0,
        errorCount: 0,
        bins: new Array<number>(BIN_COUNT).fill(0),
        meanConfidence: null,
        confidenceSum: 0,
        confidenceCount: 0,
      };
      byQuestion.set(r.questionId, q);
    }
    if (r.error !== null) {
      errorCount++;
      q.errorCount++;
      continue;
    }
    if (r.probability === null) continue;
    q.count++;
    q.bins[binIndex(r.probability)]!++;
    if (r.questionType !== "noul" && r.confidence !== null) {
      q.confidenceSum += r.confidence;
      q.confidenceCount++;
    }
  }

  const questions: QuestionDistribution[] = Array.from(byQuestion.values(), (q) => ({
    questionId: q.questionId,
    questionType: q.questionType,
    count: q.count,
    errorCount: q.errorCount,
    bins: q.bins,
    meanConfidence: q.confidenceCount === 0 ? null : q.confidenceSum / q.confidenceCount,
  }));

  // 応答時間は、リクエスト単位で数える。1リクエストで複数の質問を送ると、同じ応答時間が
  // そのリクエストの全 Result に重複して入る。費用と同じ規則で、cost が入っている Result(リクエストの先頭)だけを数える。
  const latencies = results
    .filter((r) => r.cost !== null)
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);
  const latency =
    latencies.length === 0
      ? null
      : {
          count: latencies.length,
          minMs: latencies[0] as number,
          meanMs: latencies.reduce((s, x) => s + x, 0) / latencies.length,
          medianMs: median(latencies),
          maxMs: latencies[latencies.length - 1] as number,
        };

  const billing = { requestCount: 0, totalCost: 0, inputTokens: 0, outputTokens: 0 };
  for (const r of results) {
    if (r.cost === null) continue; // リクエストの先頭ではない
    billing.requestCount++;
    billing.totalCost += r.cost;
    if (r.usage !== null) {
      billing.inputTokens += r.usage.inputTokens;
      billing.outputTokens += r.usage.outputTokens;
    }
  }
  billing.totalCost = roundCost(billing.totalCost);

  return { resultCount: results.length, errorCount, questionCount: byQuestion.size, questions, latency, billing };
}
