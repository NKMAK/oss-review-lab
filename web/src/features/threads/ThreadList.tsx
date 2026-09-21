import { useMemo } from "react";
import type { Result } from "@oss-review-lab/shared";
import { useLoadedData } from "../../data/DataContext";
import { useViewParams } from "../../params/useViewParams";
import { RunGate } from "./RunGate";
import { ThreadCard } from "./ThreadCard";
import { ThreadFilters } from "./ThreadFilters";
import { buildThreadView, filterThreadViews } from "./view";

function ThreadResults({ results }: { results: Result[] }) {
  const { threads } = useLoadedData();
  const [params] = useViewParams();
  const views = useMemo(
    () => threads.map((t) => buildThreadView(t, results, params)),
    [threads, results, params.labelThreshold, params.ackThreshold],
  );
  const shown = filterThreadViews(views, params);
  return (
    <>
      <p data-testid="thread-count" role="status">
        {`${shown.length}件 / 全${threads.length}件`}
      </p>
      {shown.length === 0 ? (
        <p data-testid="thread-empty">該当なし</p>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((v) => (
            <ThreadCard key={v.thread.threadId} view={v} params={params} />
          ))}
        </div>
      )}
    </>
  );
}

/** /threads: 絞り込み(観点が主役)と、スレッドのカード一覧。 */
export function ThreadList() {
  const [params, update] = useViewParams();
  return (
    <section data-testid="page-threads">
      <ThreadFilters params={params} update={update} />
      <RunGate>{(results) => <ThreadResults results={results} />}</RunGate>
    </section>
  );
}
