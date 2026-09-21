import Alert from "@mui/material/Alert";
import { useMemo } from "react";
import type { ReactNode } from "react";
import type { Result } from "@oss-review-lab/shared";
import { useResults } from "../../data/DataContext";
import { selectViewResults } from "../../data/compose";
import { Warnings } from "../../layout/Warnings";
import { useViewParams } from "../../params/useViewParams";

/**
 * 完了(complete)した全てのrunを合成した結果を読み込み、画面が使う結果(Result[])を子に渡す。
 * is_ack は variant: reply、観点・言い方は URL の variant(既定 parent-only)。
 * completeのrunが1つも無ければ、結果なし(未判定)として子を描画する(スレッド自体は見られる)。
 */
export function RunGate({ children }: { children: (results: Result[]) => ReactNode }) {
  const state = useResults();
  const [params] = useViewParams();
  const selected = useMemo(
    () => (state.status === "success" ? selectViewResults(state.results, params.variant) : []),
    [state, params.variant],
  );
  switch (state.status) {
    case "idle":
      return (
        <>
          <Alert severity="info" role="note" className="mb-4">
            完了(complete)したrunがありません。ラベルは未判定です。
          </Alert>
          {children([])}
        </>
      );
    case "loading":
      return <p role="status">Jevの結果を読み込み中…</p>;
    case "error":
      return (
        <Alert severity="error" role="alert">
          runの読み込みに失敗しました: {state.error.message}
        </Alert>
      );
    case "success":
      return (
        <>
          <Warnings warnings={state.warnings} />
          {children(selected)}
        </>
      );
  }
}
