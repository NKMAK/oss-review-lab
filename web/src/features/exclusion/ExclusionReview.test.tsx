import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifestText from "../../../../shared/fixtures/data/index.json?raw";
import threadsText from "../../../../shared/fixtures/data/threads/threads.jsonl?raw";
import { appRoutes } from "../../routes";
import { FIXTURE_FILES } from "../../testing/fixtures";

const files = FIXTURE_FILES;

function stubFetch(over: Record<string, string | undefined> = {}) {
  const table: Record<string, string | undefined> = { ...files, ...over };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const v = table[url];
      return Promise.resolve(v === undefined ? new Response("nf", { status: 404 }) : new Response(v));
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

async function renderAt(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  await screen.findByTestId("page-exclusion-review");
  // runの読み込みが終わるまで待つ(空の状態か、一覧のどちらかが出る)
  await waitFor(() => expect(screen.queryByTestId("loading")).toBe(null));
  return router;
}

function readRows() {
  return screen.queryAllByTestId("reply-row").map((row) => {
    const q = within(row);
    return {
      replyId: row.getAttribute("data-reply-id"),
      probability: q.getByTestId("probability").textContent,
      status: q.getByTestId("status").textContent,
      band: q.queryByTestId("band")?.textContent ?? null,
      parent: q.queryByTestId("parent-body")?.textContent ?? null,
      prior: q.queryAllByTestId("prior-body").map((e) => e.textContent),
      reply: q.getByTestId("reply-body").textContent,
    };
  });
}

const P1001 = "Dummy: this API shape and its types look fragile; a test would help.";
const P4001 = "Dummy: why is this exposed publicly? Consider a private helper.";
const P2001 = "Dummy: bot generated suggestion.";
const R1002 = "Dummy: sounds good, done.";
const R1003 = "Dummy: automated notice.";
const R4002 = "Dummy: agreed.";
const R4003 = "Dummy: fixed in the latest commit.";
const CODE_NOTE = "(bot・不明ユーザーの返信 1件は、コードで除外済み)";

describe("/review/exclusion", () => {
  it("既定の閾値0.8で、確率の降順に並ぶ。閾値ちょうど(0.8)は除外、要確認の帯は 0.8±0.1", async () => {
    stubFetch();
    await renderAt("/review/exclusion");
    expect(readRows()).toEqual([
      { replyId: "4002", probability: "99%", status: "除外", band: null, parent: P4001, prior: [], reply: R4002 },
      { replyId: "1002", probability: "97%", status: "除外", band: null, parent: P1001, prior: [], reply: R1002 },
      { replyId: "4003", probability: "85%", status: "除外", band: "要確認", parent: P4001, prior: [R4002], reply: R4003 },
      { replyId: "2002", probability: "80%", status: "除外", band: "要確認", parent: P2001, prior: [], reply: "Dummy: thanks." },
      {
        replyId: "5002",
        probability: "65%",
        status: "残る",
        band: null,
        parent: null,
        prior: [],
        reply: "Dummy: reply whose parent is outside the fetched range.",
      },
      { replyId: "4004", probability: "50%", status: "残る", band: null, parent: P4001, prior: [R4002, R4003], reply: "Dummy: thanks!" },
      { replyId: "1003", probability: "30%", status: "コード除外", band: null, parent: P1001, prior: [R1002], reply: R1003 },
      {
        replyId: "1005",
        probability: "10%",
        status: "残る",
        band: null,
        parent: P1001,
        prior: [R1002, R1003, "Dummy: comment from a deleted user."],
        reply: "Dummy: one more note, please keep the old signature for compatibility.",
      },
    ]);
    expect(screen.getByTestId("threshold-value").textContent).toBe("0.80");
    expect(screen.getByTestId("summary").textContent).toBe(`除外される返信: 4件 / 対象 7件${CODE_NOTE}`);
    expect(screen.getByTestId("rule").textContent).toBe("確率 >= 閾値なら除外");
    expect(screen.getByTestId("prob-caption").textContent).toBe("確率は「同意・完了報告である確率」です。");
  });

  it("URLの閾値を使う(0.5): 0.5ちょうどの返信が除外され、要確認の帯は 0.5±0.1", async () => {
    stubFetch();
    await renderAt("/review/exclusion?ackThreshold=0.5");
    expect(readRows().map((r) => [r.replyId, r.status, r.band])).toEqual([
      ["4002", "除外", null],
      ["1002", "除外", null],
      ["4003", "除外", null],
      ["2002", "除外", null],
      ["5002", "除外", null],
      ["4004", "除外", "要確認"],
      ["1003", "コード除外", null],
      ["1005", "残る", null],
    ]);
    expect(screen.getByTestId("summary").textContent).toBe(`除外される返信: 6件 / 対象 7件${CODE_NOTE}`);
  });

  it("bandのクエリで、要確認の帯の幅が変わる", async () => {
    stubFetch();
    await renderAt("/review/exclusion?ackThreshold=0.8&band=0.2");
    expect(readRows().map((r) => [r.replyId, r.band])).toEqual([
      ["4002", "要確認"],
      ["1002", "要確認"],
      ["4003", "要確認"],
      ["2002", "要確認"],
      ["5002", "要確認"],
      ["4004", null],
      ["1003", null],
      ["1005", null],
    ]);
  });

  it("スライダーを動かすと、除外の件数が変わり、URLとlocalStorageに閾値が残る", async () => {
    stubFetch();
    const router = await renderAt("/review/exclusion");
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0.5" } });
    expect(screen.getByTestId("threshold-value").textContent).toBe("0.50");
    expect(screen.getByTestId("summary").textContent).toBe(`除外される返信: 6件 / 対象 7件${CODE_NOTE}`);
    await waitFor(() => expect(router.state.location.search).toBe("?ackThreshold=0.5&labelThreshold=0.5"));
    expect(localStorage.getItem("oss-review-lab:ackThreshold")).toBe("0.5");
    // 観点の閾値のキーには、書かない
    expect(localStorage.getItem("oss-review-lab:labelThreshold")).toBe(null);
  });

  it("閾値を最大にしても、最小にしても、全ての返信に親コメントが残る(返信だけが除外される)", async () => {
    stubFetch();
    await renderAt("/review/exclusion?ackThreshold=1");
    const parents = [P4001, P1001, P4001, P2001, null, P4001, P1001, P1001];
    let rows = readRows();
    expect(rows.map((r) => r.status)).toEqual(["残る", "残る", "残る", "残る", "残る", "残る", "コード除外", "残る"]);
    expect(rows.map((r) => r.parent)).toEqual(parents);
    expect(screen.getByTestId("summary").textContent).toBe(`除外される返信: 0件 / 対象 7件${CODE_NOTE}`);

    fireEvent.change(screen.getByRole("slider"), { target: { value: "0" } });
    rows = readRows();
    expect(rows.map((r) => r.status)).toEqual(["除外", "除外", "除外", "除外", "除外", "除外", "コード除外", "除外"]);
    expect(rows.map((r) => r.parent)).toEqual(parents);
    expect(screen.getByTestId("summary").textContent).toBe(`除外される返信: 7件 / 対象 7件${CODE_NOTE}`);
  });

  it("本文は生のテキストとして表示し、HTMLとして解釈しない", async () => {
    const lines = threadsText.split("\n");
    const t = JSON.parse(lines[0] as string);
    t.comments[0].body = "<script>window.__xss = 1</script><b>bold</b>";
    t.comments[1].body = '<img src=x onerror="window.__xss = 2">';
    lines[0] = JSON.stringify(t);
    stubFetch({ "/data/threads/threads.jsonl": lines.join("\n") });
    await renderAt("/review/exclusion");
    const row = screen.getAllByTestId("reply-row").find((r) => r.getAttribute("data-reply-id") === "1002") as HTMLElement;
    expect(within(row).getByTestId("parent-body").textContent).toBe("<script>window.__xss = 1</script><b>bold</b>");
    expect(within(row).getByTestId("reply-body").textContent).toBe('<img src=x onerror="window.__xss = 2">');
    expect(row.querySelectorAll("script, b, img").length).toBe(0);
  });

  it("runが無いとき(is_ackの結果が無い)は、空の状態を表示する", async () => {
    const m = JSON.parse(manifestText);
    m.runs = [];
    stubFetch({ "/data/index.json": JSON.stringify(m) });
    await renderAt("/review/exclusion");
    expect(screen.getByTestId("empty").textContent).toBe(
      "is_ack の結果がありません。返信の判定(run)を実行して、データを取り込んでください。",
    );
    expect(readRows()).toEqual([]);
    expect(screen.queryByRole("slider")).toBe(null);
  });

  it("completeのrunに is_ack の結果が無いとき(観点のrunだけ)も、空の状態を表示する", async () => {
    const m = JSON.parse(manifestText);
    m.runs = m.runs.filter((r: { runId: string }) => r.runId !== "run-20260921-ack");
    stubFetch({ "/data/index.json": JSON.stringify(m) });
    await renderAt("/review/exclusion");
    expect(screen.getByTestId("empty").textContent).toBe(
      "is_ack の結果がありません。返信の判定(run)を実行して、データを取り込んでください。",
    );
  });

  it("観点のrunがあっても、runの切り替えなしで、返信が並ぶ(is_ack は別のrunから合成される)", async () => {
    stubFetch();
    await renderAt("/review/exclusion");
    expect(readRows().map((r) => r.replyId)).toEqual(["4002", "1002", "4003", "2002", "5002", "4004", "1003", "1005"]);
    expect(screen.queryByLabelText("run")).toBe(null);
  });

  it("除外の閾値の既定は0.8。観点の閾値(URL・localStorage)には影響されない", async () => {
    localStorage.setItem("oss-review-lab:labelThreshold", "0.2");
    stubFetch();
    await renderAt("/review/exclusion?labelThreshold=0.1");
    expect(screen.getByTestId("threshold-value").textContent).toBe("0.80");
  });

  it("除外の閾値は、localStorage(ackThreshold)から復元される。URLが優先。旧い `threshold` は使わない", async () => {
    localStorage.setItem("oss-review-lab:ackThreshold", "0.6");
    localStorage.setItem("oss-review-lab:threshold", "0.1");
    stubFetch();
    await renderAt("/review/exclusion");
    expect(screen.getByTestId("threshold-value").textContent).toBe("0.60");
    cleanup();
    await renderAt("/review/exclusion?ackThreshold=0.9");
    expect(screen.getByTestId("threshold-value").textContent).toBe("0.90");
  });

  it("スライダーを動かしても、保存済みの観点の閾値は変わらない。URLの観点の閾値も保たれる", async () => {
    localStorage.setItem("oss-review-lab:labelThreshold", "0.3");
    stubFetch();
    const router = await renderAt("/review/exclusion?labelThreshold=0.7");
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0.9" } });
    await waitFor(() => expect(router.state.location.search).toBe("?ackThreshold=0.9&labelThreshold=0.7"));
    expect(localStorage.getItem("oss-review-lab:labelThreshold")).toBe("0.3");
    expect(localStorage.getItem("oss-review-lab:ackThreshold")).toBe("0.9");
  });

  it("一部のrunが読めないときは、エラーを表示する", async () => {
    stubFetch({ "/data/runs/run-20260921-aspects.json": undefined });
    render(<RouterProvider router={createMemoryRouter(appRoutes, { initialEntries: ["/review/exclusion"] })} />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "runを読み込めませんでした: run-20260921-aspects: ファイルが見つかりません: /data/runs/run-20260921-aspects.json(データを取り込み済みか確認してください)",
    );
  });

  it("「confidence」の語を使わない", async () => {
    stubFetch();
    await renderAt("/review/exclusion");
    expect(screen.getByTestId("page-exclusion-review").textContent?.toLowerCase().includes("confidence")).toBe(false);
  });
});
