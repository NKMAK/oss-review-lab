import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifestText from "../../shared/fixtures/data/index.json?raw";
import threadsText from "../../shared/fixtures/data/threads/threads.jsonl?raw";
import { appRoutes } from "./routes";

const files: Record<string, string> = {
  "/data/index.json": manifestText,
  "/data/threads/threads.jsonl": threadsText,
};

function stubFetch(over: Record<string, string | number> = {}, never = false) {
  const table: Record<string, string | number> = { ...files, ...over };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (never) return new Promise<Response>(() => {});
      const v = table[url];
      if (v === undefined) return Promise.resolve(new Response("nf", { status: 404 }));
      if (typeof v === "number") return Promise.resolve(new Response("e", { status: v }));
      return Promise.resolve(new Response(v, { status: 200 }));
    }),
  );
}

function renderAt(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => vi.unstubAllGlobals());

describe("データ読み込みの状態", () => {
  it("読み込み中は、メッセージを表示し、ページは出さない", () => {
    stubFetch({}, true);
    renderAt("/threads");
    expect(screen.getByRole("status").textContent).toBe("データを読み込み中…");
    expect(screen.queryByTestId("page-threads")).toBe(null);
  });

  it("成功したら、ページとナビゲーションを表示する", async () => {
    stubFetch();
    renderAt("/threads");
    expect(await screen.findByTestId("page-threads")).toBeDefined();
    const nav = screen.getByRole("navigation");
    expect(Array.from(nav.querySelectorAll("a")).map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["スレッド一覧", "/threads"],
      ["除外の確認", "/review/exclusion"],
      ["Jev結果", "/jev"],
    ]);
  });

  it("スレッドが0件なら、空のメッセージを表示する", async () => {
    const m = JSON.parse(manifestText);
    m.threads.count = 0;
    stubFetch({ "/data/index.json": JSON.stringify(m), "/data/threads/threads.jsonl": "" });
    renderAt("/threads");
    const message = await screen.findByText(
      "スレッドが0件です。データを取り込み(import-raw → build-threads)してください。",
    );
    expect(message.closest("[role=status]")?.getAttribute("role")).toBe("status");
    expect(screen.queryByTestId("page-threads")).toBe(null);
  });

  it("Manifestが壊れていたら、原因つきのエラーを表示する", async () => {
    stubFetch({ "/data/index.json": "{ broken" });
    renderAt("/threads");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.startsWith("Manifestが不正です: Manifest(/data/index.json)のJSONが壊れています: ")).toBe(true);
  });

  it("ファイルが無い場合と、スキーマ不一致の場合で、別々のメッセージを出す", async () => {
    stubFetch({ "/data/threads/threads.jsonl": 404 });
    const { unmount } = render(<RouterProvider router={createMemoryRouter(appRoutes, { initialEntries: ["/threads"] })} />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "ファイルがありません: ファイルが見つかりません: /data/threads/threads.jsonl(データを取り込み済みか確認してください)",
    );
    unmount();

    stubFetch({ "/data/threads/threads.jsonl": '{"schemaVersion":2}\n' });
    renderAt("/threads");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.startsWith("データの形式が合いません: threads/threads.jsonl の1行目がスキーマに合いません: ")).toBe(true);
  });

  it("hash不一致などの警告は、警告として表示する", async () => {
    const m = JSON.parse(manifestText);
    m.threads.count = 9;
    stubFetch({ "/data/index.json": JSON.stringify(m) });
    renderAt("/threads");
    expect((await screen.findByTestId("page-threads")) !== null).toBe(true);
    expect(screen.getByRole("note").textContent).toBe(
      "警告: threads/threads.jsonl の件数(5)がManifestの件数(9)と一致しません",
    );
  });
});

describe("ルーティング", () => {
  it.each([
    ["/threads", "page-threads"],
    ["/threads/1001", "page-thread-detail"],
    ["/review/exclusion", "page-exclusion-review"],
    ["/jev", "page-jev"],
  ])("%s は %s を表示する", async (path, testId) => {
    stubFetch();
    renderAt(path);
    expect((await screen.findByTestId(testId)).tagName).toBe("SECTION");
  });

  it("/ は /threads に移る。未知のパスは、見つからない旨を表示する", async () => {
    stubFetch();
    const router = renderAt("/");
    await screen.findByTestId("page-threads");
    expect(router.state.location.pathname).toBe("/threads");
    router.navigate("/nope");
    expect((await screen.findByRole("heading", { name: "ページが見つかりません" })).tagName).toBe("H2");
  });
});
