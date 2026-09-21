import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import Slider from "@mui/material/Slider";
import { isAckExcluded, isReviewBand } from "@oss-review-lab/shared";
import type { Comment } from "@oss-review-lab/shared";
import { useMemo } from "react";
import { selectViewResults } from "../../data/compose";
import { useLoadedData, useResults } from "../../data/DataContext";
import { useViewParams } from "../../params/useViewParams";
import { buildExclusionRows } from "./rows";
import type { ExclusionRow } from "./rows";

const EMPTY_MESSAGE = "is_ack の結果がありません。返信の判定(run)を実行して、データを取り込んでください。";

function percent(p: number): string {
  return `${Number((p * 100).toFixed(1))}%`;
}

function who(c: Comment): string {
  return c.author ?? "(削除済みユーザー)";
}

/** 本文は、Reactのテキストとして描画する(HTMLとして解釈しない)。改行だけ保つ。 */
function Body({ testId, comment }: { testId: string; comment: Comment }) {
  return (
    <div>
      <span className="text-xs text-gray-500">{who(comment)}</span>
      <p data-testid={testId} className="whitespace-pre-wrap break-words">
        {comment.body}
      </p>
    </div>
  );
}

function Row({ row, threshold, band }: { row: ExclusionRow; threshold: number; band: number }) {
  const excludedByAck = !row.codeExcluded && isAckExcluded(row.probability, threshold);
  const inBand = !row.codeExcluded && isReviewBand(row.probability, threshold, band);
  const status = row.codeExcluded ? "コード除外" : excludedByAck ? "除外" : "残る";
  return (
    <li
      data-testid="reply-row"
      data-reply-id={row.reply.id}
      className={`rounded border p-3 ${inBand ? "border-amber-400 bg-amber-50" : "border-gray-300"} ${
        status === "残る" ? "" : "opacity-80"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span data-testid="probability" className="font-mono text-lg">
          {percent(row.probability)}
        </span>
        <Chip
          size="small"
          color={status === "残る" ? "success" : "default"}
          label={<span data-testid="status">{status}</span>}
        />
        {inBand && <Chip size="small" color="warning" label={<span data-testid="band">要確認</span>} />}
        {row.prUrl !== null && (
          <a href={row.prUrl} target="_blank" rel="noreferrer" className="text-sm underline">
            元PR
          </a>
        )}
      </div>
      <div className="space-y-2 border-l-4 border-gray-200 pl-3">
        {row.parent !== null ? (
          <div>
            <span className="text-xs font-bold text-gray-500">親コメント</span>
            <Body testId="parent-body" comment={row.parent} />
          </div>
        ) : (
          <p className="text-xs text-gray-500">親コメントがありません(取得範囲外)。</p>
        )}
        {row.priorReplies.map((c) => (
          <div key={c.id}>
            <span className="text-xs font-bold text-gray-500">先行する返信</span>
            <Body testId="prior-body" comment={c} />
          </div>
        ))}
        <div>
          <span className="text-xs font-bold">この返信</span>
          <Body testId="reply-body" comment={row.reply} />
        </div>
      </div>
    </li>
  );
}

/** 返信を is_ack の確率の降順に並べ、閾値を目で見て決めるための画面。 */
export function ExclusionReview() {
  const { threads } = useLoadedData();
  const [params, update] = useViewParams();
  const state = useResults();
  const rows = useMemo(
    () =>
      state.status === "success"
        ? buildExclusionRows(threads, selectViewResults(state.results, params.variant))
        : [],
    [state, threads, params.variant],
  );

  if (state.status === "loading") return <p role="status" data-testid="loading">runを読み込み中…</p>;
  if (state.status === "error") {
    return (
      <Alert severity="error" role="alert">
        runを読み込めませんでした: {state.error.message}
      </Alert>
    );
  }
  if (rows.length === 0) {
    return (
      <Alert severity="info" role="status" data-testid="empty">
        {EMPTY_MESSAGE}
      </Alert>
    );
  }

  const { band, ackThreshold: threshold } = params;
  const codeExcluded = rows.filter((r) => r.codeExcluded).length;
  const targets = rows.length - codeExcluded;
  const excluded = rows.filter((r) => !r.codeExcluded && isAckExcluded(r.probability, threshold)).length;
  const note = codeExcluded > 0 ? `(bot・不明ユーザーの返信 ${codeExcluded}件は、コードで除外済み)` : "";

  return (
    <>
      <div className="mb-4 space-y-2">
        <p data-testid="prob-caption">確率は「同意・完了報告である確率」です。</p>
        <p data-testid="rule" className="font-bold">
          確率 &gt;= 閾値なら除外
        </p>
        <div className="flex items-center gap-4">
          <span>
            閾値 <span data-testid="threshold-value">{threshold.toFixed(2)}</span>
          </span>
          <Slider
            aria-label="閾値"
            min={0}
            max={1}
            step={0.01}
            value={threshold}
            onChange={(_, v) => update({ ackThreshold: Array.isArray(v) ? (v[0] as number) : v })}
            sx={{ maxWidth: 400 }}
          />
        </div>
        <p data-testid="summary">{`除外される返信: ${excluded}件 / 対象 ${targets}件${note}`}</p>
        <p className="text-sm text-gray-600">
          閾値 ± {band} の返信は「要確認」の帯です。親コメントは、閾値に関わらず、一覧に残ります(除外されるのは返信だけ)。
        </p>
      </div>
      <ul className="space-y-3">
        {rows.map((row) => (
          <Row key={row.reply.id} row={row} threshold={threshold} band={band} />
        ))}
      </ul>
    </>
  );
}
