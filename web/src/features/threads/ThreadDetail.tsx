import { Link, useParams } from "react-router";
import { IS_ACK_ID, QUESTION_IDS } from "@oss-review-lab/shared";
import type { Comment, Result } from "@oss-review-lab/shared";
import { useLoadedData } from "../../data/DataContext";
import { toSearchParams } from "../../params/params";
import { useViewParams } from "../../params/useViewParams";
import { authorName, formatProbability, labelName, REPLY_EXCLUDED_LABELS, THREAD_EXCLUDED_LABELS } from "./labels";
import { RunGate } from "./RunGate";
import { buildThreadView } from "./view";

function diffKind(line: string): "hunk" | "add" | "del" | "context" {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

const DIFF_CLASSES = {
  hunk: "text-gray-500",
  add: "bg-green-100",
  del: "bg-red-100",
  context: "",
};

/** diffの該当箇所。1行ずつ、生のテキストとして表示する。 */
function Diff({ hunk }: { hunk: string }) {
  if (hunk === "") return <div data-testid="diff">diffなし</div>;
  return (
    <pre data-testid="diff" className="overflow-x-auto rounded bg-gray-50 p-2 text-sm">
      {hunk.split("\n").map((line, i) => {
        const kind = diffKind(line);
        return (
          <div key={i} data-testid="diff-line" data-kind={kind} className={`whitespace-pre ${DIFF_CLASSES[kind]}`}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

function resultsFor(comment: Comment, results: readonly Result[]): Result[] {
  const isRoot = comment.role === "root";
  return results
    .filter((r) => r.targetId === comment.id && (r.questionId === IS_ACK_ID) !== isRoot)
    .sort(
      (a, b) =>
        QUESTION_IDS.indexOf(a.questionId as (typeof QUESTION_IDS)[number]) -
        QUESTION_IDS.indexOf(b.questionId as (typeof QUESTION_IDS)[number]),
    );
}

function resultText(r: Result): string {
  const name = labelName(r.questionId);
  if (r.error !== null) return `${name} エラー: ${r.error.message}`;
  return r.probability === null ? `${name} 確率 なし` : `${name} ${formatProbability(r.probability)}`;
}

function ThreadBody({ threadId, results }: { threadId: string; results: Result[] }) {
  const { threads } = useLoadedData();
  const [params] = useViewParams();
  const thread = threads.find((t) => t.threadId === threadId);
  if (thread === undefined) return null;
  const view = buildThreadView(thread, results, params.threshold);
  const excluded = new Map(view.excludedReplies.map((e) => [e.id, e.reason]));

  return (
    <>
      <div data-testid="thread-detail" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3">
          {thread.pr !== null ? (
            <a data-testid="detail-pr-link" href={thread.pr.url} target="_blank" rel="noreferrer">
              {`PR #${thread.pr.number} ${thread.pr.title}`}
            </a>
          ) : (
            <span>PRが見つかりません</span>
          )}
          <code data-testid="detail-path">{thread.path}</code>
          {thread.excludedReason !== null && <span>{THREAD_EXCLUDED_LABELS[thread.excludedReason]}</span>}
        </div>
        <Diff hunk={thread.diffHunk} />
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {thread.comments.map((c) => {
            const reason = excluded.get(c.id);
            const rs = resultsFor(c, results);
            return (
              <li
                key={c.id}
                data-testid="timeline-comment"
                data-comment-id={c.id}
                className="rounded border border-gray-300 p-3"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                  <span data-testid="comment-role">{c.role === "root" ? "親" : "返信"}</span>
                  <span data-testid="comment-author" className="font-semibold">
                    {authorName(c.author)}
                  </span>
                  <time dateTime={c.createdAt}>{c.createdAt}</time>
                  <a data-testid="comment-link" href={c.url} target="_blank" rel="noreferrer">
                    元コメントを開く
                  </a>
                  {reason !== undefined && <span data-testid="comment-badge">{REPLY_EXCLUDED_LABELS[reason]}</span>}
                </div>
                <p data-testid="comment-body" className="my-2 whitespace-pre-wrap break-words">
                  {c.body}
                </p>
                <ul data-testid="jev-results" className="m-0 list-none p-0 text-sm">
                  {rs.map((r) => (
                    <li key={r.questionId}>{resultText(r)}</li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}

/** /threads/:id: diffの該当箇所、時系列のコメント、各コメントのJevの結果(確率)。 */
export function ThreadDetail() {
  const { id = "" } = useParams();
  const { threads } = useLoadedData();
  const [params] = useViewParams();
  const exists = threads.some((t) => t.threadId === id);
  return (
    <section data-testid="page-thread-detail">
      <Link data-testid="back-link" to={{ pathname: "/threads", search: toSearchParams(params).toString() }}>
        ← スレッド一覧へ
      </Link>
      {exists ? (
        <RunGate runId={params.run}>{(results) => <ThreadBody threadId={id} results={results} />}</RunGate>
      ) : (
        <p data-testid="thread-not-found">{`スレッド ${id} は見つかりません`}</p>
      )}
    </section>
  );
}
