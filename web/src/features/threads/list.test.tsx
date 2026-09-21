import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  await screen.findByTestId("thread-count");
  await waitFor(() => expect(screen.queryByText("Jevの結果を読み込み中…")).toBe(null));
  return router;
}

const texts = (el: HTMLElement, selector: string) =>
  Array.from(el.querySelectorAll(selector)).map((e) => e.textContent);

/** カードの構造を、比較しやすい素の値にする */
function readCard(card: HTMLElement) {
  const link = (testId: string) => {
    const a = card.querySelector(`[data-testid=${testId}]`);
    return a === null ? null : [a.textContent, a.getAttribute("href")];
  };
  return {
    id: card.dataset.threadId,
    pr: link("pr-link"),
    path: within(card).getByTestId("thread-path").textContent,
    rootBody: within(card).getByTestId("root-body").textContent,
    rootLink: link("root-link"),
    detail: link("detail-link"),
    aspects: texts(card, "[data-testid=aspect-labels] li"),
    styles: texts(card, "[data-testid=style-labels] li"),
    excludedReason: card.querySelector("[data-testid=thread-excluded-reason]")?.textContent ?? null,
    repliesSummary: within(card).queryByTestId("replies-summary")?.textContent ?? null,
    repliesOpen: (card.querySelector("details") as HTMLDetailsElement | null)?.open ?? null,
    replies: Array.from(card.querySelectorAll("[data-testid=reply]")).map((r) => ({
      id: (r as HTMLElement).dataset.replyId,
      author: r.querySelector("[data-testid=reply-author]")?.textContent,
      body: r.querySelector("[data-testid=reply-body]")?.textContent,
      badge: r.querySelector("[data-testid=reply-badge]")?.textContent ?? null,
      link: r.querySelector("a")?.getAttribute("href"),
    })),
  };
}

const cards = () => screen.queryAllByTestId("thread-card");
const cardIds = () => cards().map((c) => c.dataset.threadId);
const countText = () => screen.getByTestId("thread-count").textContent;

describe("/threads(スレッド一覧)", () => {
  it("カードに、親コメントの全文・ラベル(確率)・元PRと元コメントへのリンクが出る", async () => {
    stubFetch();
    await renderAt("/threads");
    expect(countText()).toBe("2件 / 全5件");
    expect(readCard(cards()[0]!)).toEqual({
      id: "1001",
      pr: ["PR #11 Dummy PR 11", "https://example.test/example-org/example-repo/pull/11"],
      path: "src/dummy-a.ts",
      rootBody: "Dummy: this API shape and its types look fragile; a test would help.",
      rootLink: ["元コメントを開く", "https://example.test/example-org/example-repo/pull/11#discussion_r1001"],
      detail: ["詳細", "/threads/1001?ackThreshold=0.8&labelThreshold=0.5"],
      aspects: ["設計・API 確率 90%", "型 確率 75%", "テスト 確率 60%"],
      styles: ["理由を説明 確率 70%"],
      excludedReason: null,
      // 観点(aspects の run)と is_ack(ack の run)が別々のrunでも、合成されて両方が効く。
      // 既定の除外の閾値 0.8: 1002(0.97)と、コード除外(bot・削除済み)の2件が隠れる
      repliesSummary: "返信 1件(除外 3件)",
      repliesOpen: false,
      replies: [
        {
          id: "1005",
          author: "reviewer-dummy",
          body: "Dummy: one more note, please keep the old signature for compatibility.",
          badge: null,
          link: "https://example.test/example-org/example-repo/pull/11#discussion_r1005",
        },
      ],
    });
    expect(readCard(cards()[1]!).aspects).toEqual(["設計・API 確率 55%"]);
    expect(readCard(cards()[1]!).styles).toEqual(["質問 確率 60%"]);
  });

  it("観点を複数選ぶと、いずれかを含むスレッドだけが残り、URLのクエリに反映される", async () => {
    stubFetch();
    const router = await renderAt("/threads");
    const group = screen.getByRole("group", { name: "観点" });
    await userEvent.click(within(group).getByRole("checkbox", { name: "型" }));
    expect(cardIds()).toEqual(["1001"]);
    expect(countText()).toBe("1件 / 全5件");
    await userEvent.click(within(group).getByRole("checkbox", { name: "その他" }));
    expect(cardIds()).toEqual(["1001"]);
    await userEvent.click(within(group).getByRole("checkbox", { name: "設計・API" }));
    expect(router.state.location.search).toBe("?ackThreshold=0.8&labelThreshold=0.5&aspects=design-api%2Ctypes%2Cother");
    expect(cardIds()).toEqual(["1001", "4001"]);
  });

  it("URLのクエリで、観点・言い方を指定して開ける。チェックの状態にも反映される", async () => {
    stubFetch();
    await renderAt(`/threads?aspects=design-api&styles=question`);
    expect(cardIds()).toEqual(["4001"]);
    const checked = (name: string) =>
      Array.from(within(screen.getByRole("group", { name })).getAllByRole("checkbox"))
        .filter((c) => (c as HTMLInputElement).checked)
        .map((c) => c.getAttribute("name"));
    expect(checked("観点")).toEqual(["design-api"]);
    expect(checked("言い方")).toEqual(["question"]);
  });

  it("該当ゼロは「該当なし」。件数は0件", async () => {
    stubFetch();
    await renderAt(`/threads?aspects=security`);
    expect(cardIds()).toEqual([]);
    expect(countText()).toBe("0件 / 全5件");
    expect(screen.getByTestId("thread-empty").textContent).toBe("該当なし");
  });

  it("発言者役割: PR作者の親 / PR作者以外の親", async () => {
    stubFetch();
    await renderAt(`/threads?role=pr-author`);
    expect(cardIds()).toEqual([]);
    expect(screen.getByTestId("thread-empty").textContent).toBe("該当なし");
    await userEvent.click(screen.getByRole("radio", { name: "第三者(PR作者以外)" }));
    expect(cardIds()).toEqual(["1001", "4001"]);
    await userEvent.click(screen.getByRole("radio", { name: "PR作者" }));
    expect(cardIds()).toEqual([]);
  });

  it("除外スレッドは既定で隠れ、切り替えると除外理由付きで見える", async () => {
    stubFetch();
    await renderAt("/threads");
    expect(cardIds()).toEqual(["1001", "4001"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "除外を含む" }));
    expect(cardIds()).toEqual(["1001", "2001", "3001", "4001", "5001"]);
    expect(countText()).toBe("5件 / 全5件");
    const byId = Object.fromEntries(cards().map((c) => [c.dataset.threadId as string, readCard(c)]));
    expect(
      Object.fromEntries(Object.entries(byId).map(([id, c]) => [id, [c.excludedReason, c.aspects]])),
    ).toEqual({
      "1001": [null, ["設計・API 確率 90%", "型 確率 75%", "テスト 確率 60%"]],
      "2001": ["除外: botが親コメント", ["未判定"]],
      "3001": ["除外: 削除済みユーザーが親コメント", ["未判定"]],
      "4001": [null, ["設計・API 確率 55%"]],
      "5001": ["除外: 親コメントが取得範囲外", ["未判定"]],
    });
    expect(byId["5001"]!.rootBody).toBe("親コメントは取得範囲にありません");
    expect(byId["5001"]!.rootLink).toEqual(["元コメントを開く", "https://example.test/example-org/example-repo/pull/0#discussion_r5002"]);
  });

  it("除外された返信は既定で隠れ、切り替えで理由付きで表示される(is_ack 0.5は閾値以上で除外。ackThreshold=0.5)", async () => {
    stubFetch();
    await renderAt("/threads?ackThreshold=0.5");
    const [c1001, c4001] = cards().map(readCard) as [ReturnType<typeof readCard>, ReturnType<typeof readCard>];
    expect([c1001.repliesSummary, c1001.replies.map((r) => r.id)]).toEqual(["返信 1件(除外 3件)", ["1005"]]);
    expect([c4001.repliesSummary, c4001.replies.map((r) => r.id)]).toEqual(["返信 0件(除外 3件)", []]);
    // 別のrunの観点・言い方の結果も、同じ画面で導かれる(runの切り替えは要らない)
    expect([c1001.aspects, c1001.styles]).toEqual([
      ["設計・API 確率 90%", "型 確率 75%", "テスト 確率 60%"],
      ["理由を説明 確率 70%"],
    ]);

    await userEvent.click(screen.getByRole("checkbox", { name: "除外を含む" }));
    const shown = cards().map(readCard).filter((c) => c.id === "1001" || c.id === "4001");
    expect(shown.map((c) => [c.id, c.repliesSummary, c.replies.map((r) => [r.id, r.badge])])).toEqual([
      [
        "1001",
        "返信 4件(除外 3件を含む)",
        [
          ["1002", "除外: 同意・完了報告"],
          ["1003", "除外: bot"],
          ["1004", "除外: 削除済みユーザー"],
          ["1005", null],
        ],
      ],
      [
        "4001",
        "返信 3件(除外 3件を含む)",
        [
          ["4002", "除外: 同意・完了報告"],
          ["4003", "除外: 同意・完了報告"],
          ["4004", "除外: 同意・完了報告"],
        ],
      ],
    ]);
  });

  it("閾値を上げると、除外される返信が減る(閾値ちょうどは除外)", async () => {
    stubFetch();
    await renderAt("/threads?ackThreshold=0.85");
    const c4001 = readCard(cards()[1]!);
    expect([c4001.repliesSummary, c4001.replies.map((r) => r.id)]).toEqual(["返信 1件(除外 2件)", ["4004"]]);
  });
});

describe("runの合成・variant・閾値(REQ-005 追随)", () => {
  const labelsOf = (id: string) => {
    const c = cards().find((x) => x.dataset.threadId === id) as HTMLElement;
    return [texts(c, "[data-testid=aspect-labels] li"), texts(c, "[data-testid=style-labels] li")];
  };

  it("runの選択は無い(合成した結果を使う)", async () => {
    stubFetch();
    await renderAt("/threads");
    expect(screen.queryByLabelText("run")).toBe(null);
  });

  it("partialのrun(1001に security 0.95)は、新しくても使わない", async () => {
    stubFetch();
    await renderAt("/threads");
    expect(labelsOf("1001")).toEqual([
      ["設計・API 確率 90%", "型 確率 75%", "テスト 確率 60%"],
      ["理由を説明 確率 70%"],
    ]);
  });

  it("既定は parent-only。variantのクエリで with-replies に切り替わり、観点・言い方のラベルが変わる(is_ack は reply のまま)", async () => {
    stubFetch();
    await renderAt("/threads");
    expect(labelsOf("4001")).toEqual([["設計・API 確率 55%"], ["質問 確率 60%"]]);

    cleanup();
    await renderAt("/threads?variant=with-replies");
    // with-replies のrunがあるのは 4001 だけ。1001 は with-replies の結果が無いので未判定
    expect(labelsOf("1001")).toEqual([["未判定"], ["未判定"]]);
    expect(labelsOf("4001")).toEqual([["テスト 確率 90%"], ["その他"]]);
    const c4001 = readCard(cards().find((x) => x.dataset.threadId === "4001") as HTMLElement);
    expect(c4001.repliesSummary).toBe("返信 1件(除外 2件)");
  });

  it("画面のvariantの選択で切り替わり、URLに反映される", async () => {
    stubFetch();
    const router = await renderAt("/threads");
    const select = screen.getByLabelText("ラベルの判定") as HTMLSelectElement;
    expect(Array.from(select.options, (o) => [o.value, o.textContent])).toEqual([
      ["parent-only", "親コメントだけ(parent-only)"],
      ["with-replies", "返信も含む(with-replies)"],
    ]);
    await userEvent.selectOptions(select, "with-replies");
    expect(router.state.location.search).toBe("?ackThreshold=0.8&labelThreshold=0.5&variant=with-replies");
    expect(labelsOf("4001")).toEqual([["テスト 確率 90%"], ["その他"]]);
  });

  it("with-replies のrunが無ければ、variantの選択を出さない", async () => {
    const m = JSON.parse(FIXTURE_FILES["/data/index.json"] as string);
    m.runs = m.runs.filter((r: { variant: string }) => r.variant !== "with-replies");
    stubFetch({ "/data/index.json": JSON.stringify(m) });
    await renderAt("/threads");
    expect(screen.queryByLabelText("ラベルの判定")).toBe(null);
  });

  it("観点の閾値(labelThreshold)はラベルだけ、除外の閾値(ackThreshold)は返信の除外だけを変える", async () => {
    stubFetch();
    await renderAt("/threads?labelThreshold=0.7");
    expect(labelsOf("1001")).toEqual([["設計・API 確率 90%", "型 確率 75%"], ["理由を説明 確率 70%"]]);
    expect(readCard(cards()[0]!).repliesSummary).toBe("返信 1件(除外 3件)");

    cleanup();
    await renderAt("/threads?ackThreshold=0.99");
    expect(labelsOf("1001")).toEqual([
      ["設計・API 確率 90%", "型 確率 75%", "テスト 確率 60%"],
      ["理由を説明 確率 70%"],
    ]);
    expect(readCard(cards()[0]!).repliesSummary).toBe("返信 2件(除外 2件)");
  });

  it("旧い `threshold` のクエリでは、どちらの閾値も変わらない", async () => {
    stubFetch();
    await renderAt("/threads?threshold=0.1");
    expect(labelsOf("1001")[0]).toEqual(["設計・API 確率 90%", "型 確率 75%", "テスト 確率 60%"]);
    expect(readCard(cards()[0]!).repliesSummary).toBe("返信 1件(除外 3件)");
  });

  it("一部のrunが読めないときは、エラーを表示し、ラベルを出さない(片方だけの結果を、判定済みに見せない)", async () => {
    stubFetch({ "/data/runs/run-20260921-ack.json": undefined });
    const router = createMemoryRouter(appRoutes, { initialEntries: ["/threads"] });
    render(<RouterProvider router={router} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "runの読み込みに失敗しました: run-20260921-ack: ファイルが見つかりません: /data/runs/run-20260921-ack.json(データを取り込み済みか確認してください)",
    );
    expect(screen.queryAllByTestId("thread-card")).toEqual([]);
  });

  it("completeのrunが1つも無ければ、未判定のまま一覧を出す", async () => {
    const m = JSON.parse(FIXTURE_FILES["/data/index.json"] as string);
    m.runs = m.runs.filter((r: { status: string }) => r.status !== "complete");
    stubFetch({ "/data/index.json": JSON.stringify(m) });
    await renderAt("/threads");
    expect(screen.getByRole("note").textContent).toBe("完了(complete)したrunがありません。ラベルは未判定です。");
    expect(labelsOf("1001")).toEqual([["未判定"], ["未判定"]]);
  });
});

describe("本文は生のテキスト(XSS)", () => {
  const evil = "<script>window.__xss = 1</script><img src=x onerror=\"window.__xss = 2\"><b>bold</b>";

  it("親と返信の本文の <script> や HTML は、実行も解釈もされず、文字として表示される", async () => {
    const lines = threadsText.trim().split("\n").map((l) => JSON.parse(l));
    lines[0].comments[0].body = evil;
    lines[0].comments[1].body = evil;
    const changed = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    // sha256の不一致は警告になるだけで、表示は続く
    stubFetch({ "/data/threads/threads.jsonl": changed });
    // 返信1002は、is_ack 0.97 で既定(0.8)では除外され、隠れる。表示させるため、除外の閾値を1にする
    await renderAt("/threads?ackThreshold=1");
    const card = cards()[0]!;
    expect(within(card).getByTestId("root-body").textContent).toBe(evil);
    expect(card.querySelector("[data-testid=reply-body]")?.textContent).toBe(evil);
    expect(document.querySelector("script")).toBe(null);
    expect(card.querySelector("img, b")).toBe(null);
    expect((window as unknown as { __xss?: number }).__xss).toBe(undefined);
  });
});
