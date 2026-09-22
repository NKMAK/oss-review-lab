import Alert from "@mui/material/Alert";
import Typography from "@mui/material/Typography";
import { useLoadedData, useRun } from "../data/DataContext";
import { JevView } from "../features/jev/JevView";
import { Warnings } from "../layout/Warnings";
import { useViewParams } from "../params/useViewParams";

/** /jev: Jev結果の確認(確率の分布・応答時間・使用量と費用)。正解データとの比較は行わない。 */
export default function JevPage() {
  const { manifest, defaultRunId } = useLoadedData();
  const [params, update] = useViewParams();
  // /jev は、run単位で表示する。URLに run が無ければ、既定のrun(新しい順で最初のcomplete)
  const runId = params.run ?? defaultRunId;
  const run = useRun(runId);

  return (
    <section data-testid="page-jev" className="p-4">
      <Typography variant="h5" component="h2" gutterBottom>
        Jev結果
      </Typography>
      {manifest.runs.length === 0 ? (
        <Alert severity="info" role="status">
          runがありません。Jevのrunを実行し、データを取り込んでください。
        </Alert>
      ) : (
        <>
          <div className="mb-4">
            <label>
              run{" "}
              <select value={runId ?? ""} onChange={(e) => update({ run: e.target.value })}>
                {manifest.runs.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {r.runId}({r.status})
                  </option>
                ))}
              </select>
            </label>
          </div>
          {run.status === "loading" && <p role="status">runを読み込み中…</p>}
          {run.status === "error" && (
            <Alert severity="error" role="alert">
              {run.error.kind === "not-found" ? "ファイルがありません" : "runを読み込めません"}: {run.error.message}
            </Alert>
          )}
          {run.status === "success" && (
            <>
              <Warnings warnings={run.warnings} />
              <JevView run={run.run} />
            </>
          )}
        </>
      )}
    </section>
  );
}
