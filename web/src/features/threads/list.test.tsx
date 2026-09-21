import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifestText from "../../../../shared/fixtures/data/index.json?raw";
import runAckText from "../../../../shared/fixtures/data/runs/run-20260921-ack.json?raw";
import runAspectsText from "../../../../shared/fixtures/data/runs/run-20260921-aspects.json?raw";
import threadsText from "../../../../shared/fixtures/data/threads/threads.jsonl?raw";
import { appRoutes } from "../../routes";

const RUN_ASPECTS = "run-20260921-aspects";
const RUN_ACK = "run-20260921-ack";

function stubFetch(over: Record<string, string> = {}) {
  const files: Record<string, string> = {
    "/data/index.json": manifestText,
    "/data/threads/threads.jsonl": threadsText,
    "/data/runs/run-20260921-ack.json": runAckText,
    "/data/runs/run-20260921-aspects.json": runAspectsText,
    ...over,
  };
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
    await renderAt(`/threads?run=${RUN_ASPECTS}`);
    expect(countText()).toBe("2件 / 全5件");
    expect(readCard(cards()[0]!)).toEqual({
      id: "1001",
      pr: ["PR #11 Dummy PR 11", "https://example.test/example-org/example-repo/pull/11"],
      path: "src/dummy-a.ts",
      rootBody: "Dummy: this API shape and its types look fragile; a test would help.",
      rootLink: ["元コメントを開く", "https://example.test/example-org/example-repo/pull/11#discussion_r1001"],
      detail: ["詳細", `/threads/1001?threshold=0.5&run=${RUN_ASPECTS}`],
      aspects: ["設計・API 確率 90%", "型 確率 75%", "テスト 確率 60%"],
      styles: ["理由を説明 確率 70%"],
      excludedReason: null,
      // aspects の run には is_ack が無いので、コード除外(bot・削除済み)の2件だけが隠れる
      repliesSummary: "返信 2件(除外 2件)",
      repliesOpen: false,
      replies: [
        {
          id: "1002",
          author: "alice-dummy",
          body: "Dummy: sounds good, done.",
          badge: null,
          link: "https://example.test/example-org/example-repo/pull/11#discussion_r1002",
        },
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
    const router = await renderAt(`/threads?run=${RUN_ASPECTS}`);
    const group = screen.getByRole("group", { name: "観点" });
    await userEvent.click(within(group).getByRole("checkbox", { name: "型" }));
    expect(cardIds()).toEqual(["1001"]);
    expect(countText()).toBe("1件 / 全5件");
    await userEvent.click(within(group).getByRole("checkbox", { name: "その他" }));
    expect(cardIds()).toEqual(["1001"]);
    await userEvent.click(within(group).getByRole("checkbox", { name: "設計・API" }));
    expect(router.state.location.search).toBe(`?threshold=0.5&aspects=design-api%2Ctypes%2Cother&run=${RUN_ASPECTS}`);
    expect(cardIds()).toEqual(["1001", "4001"]);
  });

  it("URLのクエリで、観点・言い方を指定して開ける。チェックの状態にも反映される", async () => {
    stubFetch();
    await renderAt(`/threads?run=${RUN_ASPECTS}&aspects=design-api&styles=question`);
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
    await renderAt(`/threads?run=${RUN_ASPECTS}&aspects=security`);
    expect(cardIds()).toEqual([]);
    expect(countText()).toBe("0件 / 全5件");
    expect(screen.getByTestId("thread-empty").textContent).toBe("該当なし");
  });

  it("発言者役割: PR作者の親 / PR作者以外の親", async () => {
    stubFetch();
    await renderAt(`/threads?run=${RUN_ASPECTS}&role=pr-author`);
    expect(cardIds()).toEqual([]);
    expect(screen.getByTestId("thread-empty").textContent).toBe("該当なし");
    await userEvent.click(screen.getByRole("radio", { name: "第三者(PR作者以外)" }));
    expect(cardIds()).toEqual(["1001", "4001"]);
    await userEvent.click(screen.getByRole("radio", { name: "PR作者" }));
    expect(cardIds()).toEqual([]);
  });

  it("除外スレッドは既定で隠れ、切り替えると除外理由付きで見える", async () => {
    stubFetch();
    await renderAt(`/threads?run=${RUN_ASPECTS}`);
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

  it("除外された返信は既定で隠れ、切り替えで理由付きで表示される(is_ack 0.5は閾値以上で除外)", async () => {
    stubFetch();
    await renderAt(`/threads?run=${RUN_ACK}`);
    const [c1001, c4001] = cards().map(readCard) as [ReturnType<typeof readCard>, ReturnType<typeof readCard>];
    expect([c1001.repliesSummary, c1001.replies.map((r) => r.id)]).toEqual(["返信 1件(除外 3件)", ["1005"]]);
    expect([c4001.repliesSummary, c4001.replies.map((r) => r.id)]).toEqual(["返信 0件(除外 3件)", []]);
    // このrunに、観点・言い方の結果は無い
    expect([c1001.aspects, c1001.styles]).toEqual([["未判定"], ["未判定"]]);

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
    await renderAt(`/threads?run=${RUN_ACK}&threshold=0.85`);
    const c4001 = readCard(cards()[1]!);
    expect([c4001.repliesSummary, c4001.replies.map((r) => r.id)]).toEqual(["返信 1件(除外 2件)", ["4004"]]);
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
    await renderAt(`/threads?run=${RUN_ASPECTS}`);
    const card = cards()[0]!;
    expect(within(card).getByTestId("root-body").textContent).toBe(evil);
    expect(card.querySelector("[data-testid=reply-body]")?.textContent).toBe(evil);
    expect(document.querySelector("script")).toBe(null);
    expect(card.querySelector("img, b")).toBe(null);
    expect((window as unknown as { __xss?: number }).__xss).toBe(undefined);
  });
});
