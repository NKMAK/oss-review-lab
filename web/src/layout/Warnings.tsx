import Alert from "@mui/material/Alert";

/** 整合の警告(hash不一致など)の表示。データ全体・run個別のどちらにも使う。 */
export function Warnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="mb-4 flex flex-col gap-2">
      {warnings.map((w) => (
        <Alert key={w} severity="warning" role="note">
          警告: {w}
        </Alert>
      ))}
    </div>
  );
}
