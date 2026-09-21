import AppBar from "@mui/material/AppBar";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Toolbar from "@mui/material/Toolbar";
import { NavLink, Outlet } from "react-router";
import { DataProvider, useData } from "../data/DataContext";
import type { DataErrorKind } from "../data/load";
import { Warnings } from "./Warnings";

const NAV_ITEMS = [
  { to: "/threads", label: "スレッド一覧" },
  { to: "/review/exclusion", label: "除外の確認" },
  { to: "/jev", label: "Jev結果" },
] as const;

const ERROR_LABELS: Record<DataErrorKind, string> = {
  "manifest-invalid": "Manifestが不正です",
  "not-found": "ファイルがありません",
  "schema-mismatch": "データの形式が合いません",
  network: "通信に失敗しました",
};

function DataGate() {
  const state = useData();
  switch (state.status) {
    case "loading":
      return <p role="status">データを読み込み中…</p>;
    case "empty":
      return (
        <>
          <Warnings warnings={state.data.warnings} />
          <Alert severity="info" role="status">
            スレッドが0件です。データを取り込み(import-raw → build-threads)してください。
          </Alert>
        </>
      );
    case "error":
      return (
        <Alert severity="error" role="alert">
          {ERROR_LABELS[state.error.kind]}: {state.error.message}
        </Alert>
      );
    case "success":
      return (
        <>
          <Warnings warnings={state.data.warnings} />
          <Outlet />
        </>
      );
  }
}

/**
 * 全画面共通のレイアウト: ナビゲーションと、データの読み込み状態の表示。
 * 読み込みに成功したときだけ、子の画面(Outlet)を描画する。
 */
export function Layout() {
  return (
    <DataProvider>
      <AppBar position="static" color="default" elevation={0}>
        <Toolbar component="nav" variant="dense">
          {NAV_ITEMS.map((item) => (
            <Button key={item.to} component={NavLink} to={item.to} color="inherit">
              {item.label}
            </Button>
          ))}
        </Toolbar>
      </AppBar>
      <main className="mx-auto max-w-6xl p-4">
        <DataGate />
      </main>
    </DataProvider>
  );
}
