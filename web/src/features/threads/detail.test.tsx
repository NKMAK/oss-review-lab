import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import threadsText from "../../../../shared/fixtures/data/threads/threads.jsonl?raw";
import { appRoutes } from "../../routes";
import { FIXTURE_FILES } from "../../testing/fixtures";

function stubFetch(over: Record<string, string | undefined> = {}) {
  const files: Record<string, string | undefined> = { ...FIXTURE_FILES, ...over };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const v = files[url];
      return Promise.resolve(v === undefined ? new Response("nf", { status: 404 }) : new Response(v));
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

async function renderAt(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  await screen.findByTestId("thread-detail");
  await waitFor(() => expect(screen.queryByText("Jevの結果を読み込み中…")).toBe(null));
  return router;
}

const texts = (el: ParentNode, selector: string) =>
  Array.from(el.querySelectorAll(selector)).map((e) => e.textContent);

function readTimeline() {
  return screen.getAllByTestId("timeline-comment").map((c) => ({
    id: (c as HTMLElement).dataset.commentId,
    role: c.querySelector("[data-testid=comment-role]")?.textContent,
    author: c.querySelector("[data-testid=comment-author]")?.textContent,
    createdAt: c.querySelector("time")?.textContent,
    link: [
      c.querySelector("[data-testid=comment-link]")?.textContent,
      c.querySelector("[data-testid=comment-link]")?.getAttribute("href"),
    ],
    body: c.querySelector("[data-testid=comment-body]")?.textContent,
    badge: c.querySelector("[data-testid=comment-badge]")?.textContent ?? null,
    results: texts(c, "[data-testid=jev-results] li"),
  }));
}

describe("/threads/:id(スレッド詳細)", () => {
  it("diffの該当箇所と、時系列のコメントと、各コメントのJevの結果(確率)が見える", async () => {
    stubFetch();
    await renderAt(`/threads/1001`);
    expect(screen.getByTestId("detail-pr-link").textContent).toBe("PR #11 Dummy PR 11");
    expect(screen.getByTestId("detail-pr-link").getAttribute("href")).toBe(
      "https://example.test/example-org/example-repo/pull/11",
    );
    expect(screen.getByTestId("detail-path").textContent).toBe("src/dummy-a.ts");
    expect(
      Array.from(screen.getByTestId("diff").querySelectorAll("[data-testid=diff-line]")).map((l) => [
        (l as HTMLElement).dataset.kind,
        l.textContent,
      ]),
    ).toEqual([
      ["hunk", "@@ -1,3 +1,3 @@"],
      ["del", "-const a = 1;"],
      ["add", "+const a = 2;"],
      ["context", " const b = 3;"],
    ]);

    const timeline = readTimeline();
    expect(timeline.map((c) => c.id)).toEqual(["1001", "1002", "1003", "1004", "1005"]);
    expect(timeline[0]).toEqual({
      id: "1001",
      role: "親",
      author: "reviewer-dummy",
      createdAt: "2026-01-01T00:00:00Z",
      link: ["元コメントを開く", "https://example.test/example-org/example-repo/pull/11#discussion_r1001"],
      body: "Dummy: this API shape and its types look fragile; a test would help.",
      badge: null,
      results: [
        "設計・API 確率 90%",
        "型 確率 75%",
        "バグ・境界条件 確率 10%",
        "互換性・リリース 確率 20%",
        "テスト 確率 60%",
        "可読性・命名 確率 5%",
        "ドキュメント・コメント 確率 2%",
        "セキュリティ 確率 1%",
        "パフォーマンス エラー: dummy: response did not match contract",
        "依存・ビルド 確率 4%",
        "修正案を示す 確率 20%",
        "理由を説明 確率 70%",
        "質問 確率 10%",
        "文脈の共有 確率 5%",
        "機能要望 確率 15%",
      ],
    });
    // 返信のJevの結果は、別のrun(ack)から合成される。既定の除外の閾値 0.8: 1002(0.97)が除外。
    // bot・削除済みは、詳細では時系列に残し、除外の印を付ける
    expect(timeline.slice(1).map((c) => [c.id, c.role, c.author, c.createdAt, c.badge, c.results])).toEqual([
      ["1002", "返信", "alice-dummy", "2026-01-01T01:00:00Z", "除外: 同意・完了報告", ["同意・完了報告 確率 97%"]],
      ["1003", "返信", "bot-dummy[bot]", "2026-01-01T02:00:00Z", "除外: bot", ["同意・完了報告 確率 30%"]],
      ["1004", "返信", "(削除済みユーザー)", "2026-01-01T03:00:00Z", "除外: 削除済みユーザー", []],
      ["1005", "返信", "reviewer-dummy", "2026-01-01T04:00:00Z", null, ["同意・完了報告 確率 10%"]],
    ]);
  });

  it("返信のJevの結果は、is_ackの確率として出る。閾値以上なら除外の印が付く", async () => {
    stubFetch();
    await renderAt("/threads/1001?ackThreshold=0.97");
    expect(readTimeline().map((c) => [c.id, c.badge, c.results.length === 15 ? "15件" : c.results])).toEqual([
      ["1001", null, "15件"],
      ["1002", "除外: 同意・完了報告", ["同意・完了報告 確率 97%"]],
      ["1003", "除外: bot", ["同意・完了報告 確率 30%"]],
      ["1004", "除外: 削除済みユーザー", []],
      ["1005", null, ["同意・完了報告 確率 10%"]],
    ]);
  });

  it("noulの結果に「confidence」の語を使わない", async () => {
    stubFetch();
    await renderAt(`/threads/1001`);
    expect((document.body.textContent ?? "").toLowerCase().includes("confidence")).toBe(false);
  });

  it("一覧へ戻るリンクは、絞り込みのクエリを保つ", async () => {
    stubFetch();
    await renderAt(`/threads/1001?aspects=types`);
    expect(screen.getByTestId("back-link").getAttribute("href")).toBe(
      "/threads?ackThreshold=0.8&labelThreshold=0.5&aspects=types",
    );
  });

  it("diffが無いスレッドは「diffなし」。親が無いスレッドは、時系列を返信だけで出す", async () => {
    stubFetch();
    await renderAt(`/threads/5001`);
    expect(screen.getByTestId("diff").textContent).toBe("diffなし");
    expect(readTimeline().map((c) => [c.id, c.role])).toEqual([["5002", "返信"]]);
  });

  it("存在しないスレッドは、その旨を表示する", async () => {
    stubFetch();
    const router = createMemoryRouter(appRoutes, { initialEntries: ["/threads/9999"] });
    render(<RouterProvider router={router} />);
    expect((await screen.findByTestId("thread-not-found")).textContent).toBe("スレッド 9999 は見つかりません");
  });
});

describe("合成・variant", () => {
  it("観点の結果は選んだvariantのもの。with-replies を選ぶと、そのrunの値になる(is_ack は reply のまま)", async () => {
    stubFetch();
    await renderAt("/threads/4001");
    let t = readTimeline();
    expect(t[0]!.results.slice(0, 2)).toEqual(["設計・API 確率 55%", "型 確率 10%"]);
    expect(t[1]!.results).toEqual(["同意・完了報告 確率 99%"]);

    cleanup();
    await renderAt("/threads/4001?variant=with-replies");
    t = readTimeline();
    expect(t[0]!.results.slice(0, 2)).toEqual(["設計・API 確率 20%", "型 確率 10%"]);
    expect(t[0]!.results[4]).toBe("テスト 確率 90%");
    expect(t[1]!.results).toEqual(["同意・完了報告 確率 99%"]);
  });

  it("partialのrunの値(1001の security 0.95)は使わない", async () => {
    stubFetch();
    await renderAt("/threads/1001");
    expect(readTimeline()[0]!.results[7]).toBe("セキュリティ 確率 1%");
  });

  it("runの読み込みに失敗したら、エラーを表示する", async () => {
    stubFetch({ "/data/runs/run-20260921-aspects.json": undefined });
    const router = createMemoryRouter(appRoutes, { initialEntries: ["/threads/1001"] });
    render(<RouterProvider router={router} />);
    expect((await screen.findByRole("alert")).textContent).toContain("runの読み込みに失敗しました: run-20260921-aspects");
  });
});

describe("本文とdiffは生のテキスト(XSS)", () => {
  it("<script> は実行されず、文字として表示される", async () => {
    const evil = "<script>window.__xssDetail = 1</script><img src=x onerror=\"window.__xssDetail = 2\">";
    const lines = threadsText.trim().split("\n").map((l) => JSON.parse(l));
    lines[0].comments[0].body = evil;
    lines[0].comments[1].body = evil;
    lines[0].diffHunk = `@@ -1 +1 @@\n+${evil}`;
    stubFetch({ "/data/threads/threads.jsonl": lines.map((l) => JSON.stringify(l)).join("\n") + "\n" });
    await renderAt(`/threads/1001`);
    const t = readTimeline();
    expect([t[0]!.body, t[1]!.body]).toEqual([evil, evil]);
    expect(texts(screen.getByTestId("diff"), "[data-testid=diff-line]")).toEqual(["@@ -1 +1 @@", `+${evil}`]);
    expect(document.querySelector("script")).toBe(null);
    expect(document.querySelector("img")).toBe(null);
    expect((window as unknown as { __xssDetail?: number }).__xssDetail).toBe(undefined);
  });
});
