import Chip from "@mui/material/Chip";
import { Link } from "react-router";
import type { ViewParams } from "../../params/params";
import { toSearchParams } from "../../params/params";
import { authorName, formatProbability, labelName, REPLY_EXCLUDED_LABELS, THREAD_EXCLUDED_LABELS } from "./labels";
import type { ThreadView } from "./view";

function LabelList({ testId, ids, view, judged }: { testId: string; ids: string[]; view: ThreadView; judged: boolean }) {
  return (
    <ul data-testid={testId} className="m-0 flex list-none flex-wrap gap-1 p-0">
      {!judged && (
        <li>
          <Chip size="small" variant="outlined" label="未判定" />
        </li>
      )}
      {ids.map((id) => {
        const p = view.probabilities[id];
        return (
          <li key={id}>
            <Chip size="small" label={p === undefined ? labelName(id) : `${labelName(id)} ${formatProbability(p)}`} />
          </li>
        );
      })}
    </ul>
  );
}

/** 一覧のカード。本文は生のテキスト(HTMLとして解釈しない)。 */
export function ThreadCard({ view, params }: { view: ThreadView; params: ViewParams }) {
  const { thread, root } = view;
  const excludedIds = new Map(view.excludedReplies.map((e) => [e.id, e.reason]));
  const replies = thread.comments.filter((c) => c.role === "reply");
  const shown = params.showExcluded ? replies : replies.filter((c) => !excludedIds.has(c.id));
  const excludedCount = replies.length - replies.filter((c) => !excludedIds.has(c.id)).length;
  const sourceComment = root ?? thread.comments[0];

  let summary = shown.length === 0 && excludedCount === 0 ? "返信なし" : `返信 ${shown.length}件`;
  if (excludedCount > 0) summary += params.showExcluded ? `(除外 ${excludedCount}件を含む)` : `(除外 ${excludedCount}件)`;

  return (
    <article data-testid="thread-card" data-thread-id={thread.threadId} className="rounded border border-gray-300 p-3">
      <header className="mb-2 flex flex-wrap items-baseline gap-x-3">
        {thread.pr !== null ? (
          <a data-testid="pr-link" href={thread.pr.url} target="_blank" rel="noreferrer">
            {`PR #${thread.pr.number} ${thread.pr.title}`}
          </a>
        ) : (
          <span>PRが見つかりません</span>
        )}
        <code data-testid="thread-path">{thread.path}</code>
        {thread.excludedReason !== null && (
          <Chip
            size="small"
            color="warning"
            data-testid="thread-excluded-reason"
            label={THREAD_EXCLUDED_LABELS[thread.excludedReason]}
          />
        )}
      </header>

      <p data-testid="root-body" className="my-2 whitespace-pre-wrap break-words">
        {root !== null ? root.body : "親コメントは取得範囲にありません"}
      </p>
      <div className="mb-2 flex flex-wrap gap-3">
        {sourceComment !== undefined && (
          <a data-testid="root-link" href={sourceComment.url} target="_blank" rel="noreferrer">
            元コメントを開く
          </a>
        )}
        <Link
          data-testid="detail-link"
          to={{ pathname: `/threads/${thread.threadId}`, search: toSearchParams(params).toString() }}
        >
          詳細
        </Link>
      </div>

      <div className="mb-2 flex flex-col gap-1">
        <LabelList testId="aspect-labels" ids={view.labels.aspects} view={view} judged={view.judged} />
        <LabelList testId="style-labels" ids={view.labels.styles} view={view} judged={view.judged} />
      </div>

      <details>
        <summary data-testid="replies-summary">{summary}</summary>
        <ul className="m-0 list-none p-0">
          {shown.map((c) => {
            const reason = excludedIds.get(c.id);
            return (
              <li key={c.id} data-testid="reply" data-reply-id={c.id} className="mt-2 border-l-2 border-gray-300 pl-3">
                <span data-testid="reply-author" className="font-semibold">
                  {authorName(c.author)}
                </span>
                {reason !== undefined && (
                  <Chip
                    size="small"
                    variant="outlined"
                    className="ml-2"
                    data-testid="reply-badge"
                    label={REPLY_EXCLUDED_LABELS[reason]}
                  />
                )}
                <p data-testid="reply-body" className="my-1 whitespace-pre-wrap break-words">
                  {c.body}
                </p>
                <a href={c.url} target="_blank" rel="noreferrer">
                  元コメントを開く
                </a>
              </li>
            );
          })}
        </ul>
      </details>
    </article>
  );
}
