import Alert from "@mui/material/Alert";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { Run } from "@oss-review-lab/shared";
import { aggregateResults, BIN_COUNT } from "./aggregate";
import type { Aggregate, QuestionDistribution } from "./aggregate";

function binLabel(i: number): string {
  return `${(i / BIN_COUNT).toFixed(1)}-${((i + 1) / BIN_COUNT).toFixed(1)}`;
}

function ms(x: number): string {
  return `${Math.round(x)} ms`;
}

function summaryRows(a: Aggregate): [string, string][] {
  const rows: [string, string][] = [
    ["質問数", String(a.questionCount)],
    ["結果数", String(a.resultCount)],
    ["エラー", `${a.errorCount}件(確率の分布に含めない)`],
  ];
  if (a.latency !== null) {
    rows.push(
      ["応答時間(最小)", ms(a.latency.minMs)],
      ["応答時間(平均)", ms(a.latency.meanMs)],
      ["応答時間(中央値)", ms(a.latency.medianMs)],
      ["応答時間(最大)", ms(a.latency.maxMs)],
    );
  }
  rows.push(
    ["リクエスト数", String(a.billing.requestCount)],
    ["入力トークン", String(a.billing.inputTokens)],
    ["出力トークン", String(a.billing.outputTokens)],
    ["費用(cost の合計)", `$${a.billing.totalCost.toFixed(4)}`],
  );
  return rows;
}

function Distribution({ q }: { q: QuestionDistribution }) {
  const max = Math.max(...q.bins);
  const meta = [q.questionType, `確率 ${q.count}件`, `エラー ${q.errorCount}件`];
  if (q.meanConfidence !== null) meta.push(`confidence平均 ${q.meanConfidence}`);
  return (
    <section data-testid={`jev-dist-${q.questionId}`} className="mb-6">
      <Typography variant="h6" component="h3">
        {q.questionId}
      </Typography>
      <Typography variant="body2" color="text.secondary" data-testid="jev-dist-meta">
        {meta.join("・")}
      </Typography>
      <Table size="small" aria-label={`${q.questionId} の確率の分布`}>
        <TableBody>
          {q.bins.map((count, i) => (
            <TableRow key={i}>
              <TableCell component="th" scope="row" sx={{ width: "6rem" }}>
                {binLabel(i)}
              </TableCell>
              <TableCell sx={{ width: "4rem" }}>{count}</TableCell>
              <TableCell aria-hidden="true">
                <div
                  data-bar
                  style={{
                    width: `${max === 0 ? 0 : (count / max) * 100}%`,
                    height: "0.75rem",
                    background: "currentColor",
                    opacity: 0.6,
                    borderRadius: "2px",
                  }}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

/** 選択されたrunの表示。complete 以外は、集計から外し、その旨を注記する。 */
export function JevView({ run }: { run: Run }) {
  if (run.status === "partial") {
    return (
      <Alert severity="info" role="status">
        このrun({run.runId})は途中で止まっている(partial)ため、集計から外しています。
      </Alert>
    );
  }
  if (run.status === "failed") {
    return (
      <Alert severity="info" role="status">
        このrun({run.runId})は失敗している(failed)ため、集計から外しています。
      </Alert>
    );
  }
  if (run.results.length === 0) {
    return (
      <Alert severity="info" role="status">
        このrun({run.runId})には結果がありません。
      </Alert>
    );
  }
  const agg = aggregateResults(run.results);
  return (
    <div>
      <Table size="small" data-testid="jev-summary" aria-label="集計" className="mb-6">
        <TableBody>
          {summaryRows(agg).map(([label, value]) => (
            <TableRow key={label}>
              <TableCell component="th" scope="row">
                {label}
              </TableCell>
              <TableCell>{value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Typography variant="h5" component="h2" gutterBottom>
        確率の分布(質問ごと)
      </Typography>
      {agg.questions.map((q) => (
        <Distribution key={q.questionId} q={q} />
      ))}
    </div>
  );
}
