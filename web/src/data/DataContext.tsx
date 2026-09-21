import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Run } from "@oss-review-lab/shared";
import { DataLoadError, loadData, loadRun } from "./load";
import type { DataErrorKind, LoadedData } from "./load";

export type DataError = { kind: DataErrorKind; message: string };

/**
 * データ全体の状態。
 * success 以外のときは、共通のレイアウトがメッセージを出し、ページ(Outlet)は描画しない。
 * なので、各画面は `useLoadedData()` で success のデータだけを受け取ればよい。
 */
export type DataState =
  | { status: "loading" }
  | { status: "empty"; data: LoadedData }
  | { status: "error"; error: DataError }
  | { status: "success"; data: LoadedData };

export type RunState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: DataError }
  | { status: "success"; run: Run; warnings: string[] };

const DataContext = createContext<DataState | null>(null);

export function toDataError(e: unknown): DataError {
  if (e instanceof DataLoadError) return { kind: e.kind, message: e.message };
  return { kind: "network", message: e instanceof Error ? e.message : String(e) };
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DataState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadData().then(
      (data) => {
        if (cancelled) return;
        setState({ status: data.threads.length === 0 ? "empty" : "success", data });
      },
      (e: unknown) => {
        if (!cancelled) setState({ status: "error", error: toDataError(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return <DataContext.Provider value={state}>{children}</DataContext.Provider>;
}

/** 読み込みの状態そのもの(レイアウト用)。 */
export function useData(): DataState {
  const state = useContext(DataContext);
  if (state === null) throw new Error("useData は DataProvider の中で使ってください");
  return state;
}

/** 読み込みに成功したデータ。成功前に呼ぶと例外(レイアウトが、成功時だけページを描画する)。 */
export function useLoadedData(): LoadedData {
  const state = useData();
  if (state.status !== "success") {
    throw new Error("useLoadedData は、データの読み込みに成功した後の画面でだけ使ってください");
  }
  return state.data;
}

/** 選択されたrunを読む。runIdが null(runが無い)なら idle。runIdが変わると読み直す。 */
export function useRun(runId: string | null): RunState {
  const data = useLoadedData();
  const [result, setResult] = useState<{ runId: string; state: RunState } | null>(null);

  useEffect(() => {
    if (runId === null) return;
    let cancelled = false;
    loadRun(data.manifest, runId).then(
      ({ run, warnings }) => {
        if (!cancelled) setResult({ runId, state: { status: "success", run, warnings } });
      },
      (e: unknown) => {
        if (!cancelled) setResult({ runId, state: { status: "error", error: toDataError(e) } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [data.manifest, runId]);

  if (runId === null) return { status: "idle" };
  if (result === null || result.runId !== runId) return { status: "loading" };
  return result.state;
}
