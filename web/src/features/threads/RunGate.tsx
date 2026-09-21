import Alert from "@mui/material/Alert";
import type { ReactNode } from "react";
import type { Result } from "@oss-review-lab/shared";
import { useRun } from "../../data/DataContext";
import { Warnings } from "../../layout/Warnings";

/**
 * 選択中のrunを読み込み、結果(Result[])を子に渡す。
 * runが1つも無ければ、結果なし(未判定)として子を描画する(スレッド自体は見られる)。
 */
export function RunGate({ runId, children }: { runId: string | null; children: (results: Result[]) => ReactNode }) {
  const run = useRun(runId);
  switch (run.status) {
    case "idle":
      return (
        <>
          <Alert severity="info" role="note" className="mb-4">
            Jevのrunがありません。ラベルは未判定です。
          </Alert>
          {children([])}
        </>
      );
    case "loading":
      return <p role="status">Jevの結果を読み込み中…</p>;
    case "error":
      return (
        <Alert severity="error" role="alert">
          runの読み込みに失敗しました: {run.error.message}
        </Alert>
      );
    case "success":
      return (
        <>
          <Warnings warnings={run.warnings} />
          {children(run.run.results)}
        </>
      );
  }
}
