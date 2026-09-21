import { createHash } from "node:crypto";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@oss-review-lab/shared";
import manifestText from "../../../../shared/fixtures/data/index.json?raw";
import runAckText from "../../../../shared/fixtures/data/runs/run-20260921-ack.json?raw";
import threadsText from "../../../../shared/fixtures/data/threads/threads.jsonl?raw";
import { appRoutes } from "../../routes";

const HASH = "0".repeat(64);

function result(over: Partial<Result>): Result {
  return {
    targetId: "1001",
    questionId: "design-api",
    questionType: "noul",
    questionDefHash: HASH,
    stateHash: HASH,
    variant: "parent-only",
    raw: null,
    probability: 0.5,
    confidence: null,
    latencyMs: 100,
    usage: null,
    cost: null,
    error: null,
    ...over,
  };
}

const USAGE_A = { inputTokens: 100, outputTokens: 10 };
const USAGE_B = { inputTokens: 200, outputTokens: 20 };

/** 2リクエスト(1001, 1002)。usageは同じリクエストのResultに重複、costは先頭だけ。tests の1件は失敗 */
const COMPLETE_RESULTS: Result[] = [
  result({ targetId: "1001", questionId: "design-api", probability: 0.9, latencyMs: 100, usage: USAGE_A, cost: 0.01 }),
  result({ targetId: "1001", questionId: "types", probability: 0.75, latencyMs: 200, usage: USAGE_A }),
  result({
    targetId: "1001",
    questionId: "tests",
    probability: null,
    latencyMs: 300,
    error: { kind: "fatal", message: "boom", attempts: 3 },
  }),
  result({ targetId: "1002", questionId: "design-api", probability: 0.05, latencyMs: 1000, usage: USAGE_B, cost: 0.02 }),
  result({ targetId: "1002", questionId: "types", probability: 0.75, latencyMs: 400, usage: USAGE_B }),
];

const CHOICE_RESULTS: Result[] = [
  result({ questionId: "kind", questionType: "choice", probability: 0.8, confidence: 0.5, usage: USAGE_A, cost: 0.005 }),
  result({ targetId: "1002", questionId: "kind", questionType: "choice", probability: 0.2, confidence: 1, usage: USAGE_B, cost: 0.005 }),
];

type RunSpec = { runId: string; status: "complete" | "partial" | "failed"; createdAt: string; results: Result[] };

function buildFiles(specs: RunSpec[]): Record<string, string> {
  const base = JSON.parse(runAckText) as Record<string, unknown>;
  const manifest = JSON.parse(manifestText) as { runs: unknown[] };
  const files: Record<string, string> = {
    "/data/threads/threads.jsonl": threadsText,
  };
  manifest.runs = specs.map((s) => {
    const text = JSON.stringify({ ...base, runId: s.runId, status: s.status, results: s.results });
    const file = `runs/${s.runId}.json`;
    files[`/data/${file}`] = text;
    return {
      runId: s.runId,
      status: s.status,
      file,
      sha256: createHash("sha256").update(text).digest("hex"),
      createdAt: s.createdAt,
      variant: "reply",
    };
  });
  files["/data/index.json"] = JSON.stringify(manifest);
  return files;
}

const SPECS: RunSpec[] = [
  { runId: "run-c", status: "complete", createdAt: "2026-09-21T03:00:00Z", results: COMPLETE_RESULTS },
  { runId: "run-d", status: "complete", createdAt: "2026-09-21T02:00:00Z", results: CHOICE_RESULTS },
  { runId: "run-p", status: "partial", createdAt: "2026-09-21T01:00:00Z", results: COMPLETE_RESULTS },
  { runId: "run-f", status: "failed", createdAt: "2026-09-21T00:00:00Z", results: [] },
];

function stubFetch(files: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const v = files[url];
      return Promise.resolve(v === undefined ? new Response("nf", { status: 404 }) : new Response(v));
    }),
  );
}

function renderAt(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => vi.unstubAllGlobals());

function rows(table: HTMLElement): string[][] {
  return Array.from(table.querySelectorAll("tr")).map((tr) =>
    Array.from(tr.querySelectorAll("th,td"), (c) => c.textContent as string),
  );
}

describe("/jev", () => {
  it("既定のrun(新しい順で最初のcomplete)の、質問数・エラー・応答時間・使用量・費用を表示する", async () => {
    stubFetch(buildFiles(SPECS));
    renderAt("/jev");
    const summary = await screen.findByTestId("jev-summary");
    expect(rows(summary)).toEqual([
      ["質問数", "3"],
      ["結果数", "5"],
      ["エラー", "1件(確率の分布に含めない)"],
      ["応答時間(最小)", "100 ms"],
      ["応答時間(平均)", "400 ms"],
      ["応答時間(中央値)", "300 ms"],
      ["応答時間(最大)", "1000 ms"],
      ["リクエスト数", "2"],
      ["入力トークン", "300"],
      ["出力トークン", "30"],
      ["費用(cost の合計)", "$0.0300"],
    ]);
    expect((screen.getByLabelText("run") as HTMLSelectElement).value).toBe("run-c");
  });

  it("確率の分布は、質問ごとに、10区間の件数と棒で表示する。エラーは含めない", async () => {
    stubFetch(buildFiles(SPECS));
    renderAt("/jev");
    await screen.findByTestId("jev-summary");

    const design = screen.getByTestId("jev-dist-design-api");
    expect(within(design).getByRole("heading").textContent).toBe("design-api");
    expect(within(design).getByTestId("jev-dist-meta").textContent).toBe("noul・確率 2件・エラー 0件");
    expect(rows(design.querySelector("table") as HTMLElement).map((r) => r.slice(0, 2))).toEqual([
      ["0.0-0.1", "1"],
      ["0.1-0.2", "0"],
      ["0.2-0.3", "0"],
      ["0.3-0.4", "0"],
      ["0.4-0.5", "0"],
      ["0.5-0.6", "0"],
      ["0.6-0.7", "0"],
      ["0.7-0.8", "0"],
      ["0.8-0.9", "0"],
      ["0.9-1.0", "1"],
    ]);
    expect(Array.from(design.querySelectorAll<HTMLElement>("[data-bar]"), (b) => b.style.width)).toEqual([
      "100%", "0%", "0%", "0%", "0%", "0%", "0%", "0%", "0%", "100%",
    ]);

    const types = screen.getByTestId("jev-dist-types");
    expect(rows(types.querySelector("table") as HTMLElement).map((r) => r[1])).toEqual([
      "0", "0", "0", "0", "0", "0", "0", "2", "0", "0",
    ]);

    const tests = screen.getByTestId("jev-dist-tests");
    expect(within(tests).getByTestId("jev-dist-meta").textContent).toBe("noul・確率 0件・エラー 1件");
    expect(rows(tests.querySelector("table") as HTMLElement).map((r) => r[1])).toEqual([
      "0", "0", "0", "0", "0", "0", "0", "0", "0", "0",
    ]);
  });

  it("二重計上しない: usage が重複して入っていても、費用とトークンはリクエスト単位(cost のある Result)で数える", async () => {
    stubFetch(buildFiles(SPECS));
    renderAt("/jev");
    const summary = await screen.findByTestId("jev-summary");
    const table = Object.fromEntries(rows(summary));
    // Resultごとに usage を足すと、入力は 100*2+200*2=600、出力は 60 になってしまう
    expect(table["入力トークン"]).toBe("300");
    expect(table["出力トークン"]).toBe("30");
    expect(table["リクエスト数"]).toBe("2");
    expect(table["費用(cost の合計)"]).toBe("$0.0300");
  });

  it("noulの結果には「confidence」の語を出さない", async () => {
    stubFetch(buildFiles(SPECS));
    renderAt("/jev");
    await screen.findByTestId("jev-summary");
    expect(document.body.textContent?.includes("confidence")).toBe(false);
  });

  it("choiceの質問は、confidenceの平均を表示する", async () => {
    stubFetch(buildFiles(SPECS));
    renderAt("/jev?run=run-d");
    const kind = await screen.findByTestId("jev-dist-kind");
    expect(within(kind).getByTestId("jev-dist-meta").textContent).toBe(
      "choice・確率 2件・エラー 0件・confidence平均 0.75",
    );
  });

  it("runの選択で、表示が切り替わり、URLのクエリが変わる", async () => {
    stubFetch(buildFiles(SPECS));
    const router = renderAt("/jev");
    await screen.findByTestId("jev-dist-design-api");
    const select = screen.getByLabelText("run") as HTMLSelectElement;
    expect(Array.from(select.options, (o) => [o.value, o.textContent])).toEqual([
      ["run-c", "run-c(complete)"],
      ["run-d", "run-d(complete)"],
      ["run-p", "run-p(partial)"],
      ["run-f", "run-f(failed)"],
    ]);

    fireEvent.change(select, { target: { value: "run-d" } });
    const kind = await screen.findByTestId("jev-dist-kind");
    expect(kind.tagName).toBe("SECTION");
    expect(screen.queryByTestId("jev-dist-design-api")).toBe(null);
    expect(rows(screen.getByTestId("jev-summary")).slice(0, 2)).toEqual([
      ["質問数", "1"],
      ["結果数", "2"],
    ]);
    expect(router.state.location.search).toBe("?threshold=0.5&run=run-d");
  });

  it("partialのrunは、集計から外し、その旨を注記する", async () => {
    stubFetch(buildFiles(SPECS));
    renderAt("/jev?run=run-p");
    await screen.findByTestId("page-jev");
    const note = await screen.findByText(/集計から外しています/);
    expect(note.closest("[role=status]")?.textContent).toBe(
      "このrun(run-p)は途中で止まっている(partial)ため、集計から外しています。",
    );
    expect(screen.queryByTestId("jev-summary")).toBe(null);
    expect(screen.queryByTestId("jev-dist-design-api")).toBe(null);
  });

  it("failedのrunは、集計から外し、その旨を注記する", async () => {
    stubFetch(buildFiles(SPECS));
    renderAt("/jev?run=run-f");
    await screen.findByTestId("page-jev");
    const note = await screen.findByText(/集計から外しています/);
    expect(note.closest("[role=status]")?.textContent).toBe("このrun(run-f)は失敗している(failed)ため、集計から外しています。");
    expect(screen.queryByTestId("jev-summary")).toBe(null);
  });

  it("completeでも結果が空なら、空の状態を表示する", async () => {
    stubFetch(buildFiles([{ runId: "run-e", status: "complete", createdAt: "2026-09-21T00:00:00Z", results: [] }]));
    renderAt("/jev");
    await screen.findByTestId("page-jev");
    expect((await screen.findByText(/には結果がありません/)).closest("[role=status]")?.textContent).toBe("このrun(run-e)には結果がありません。");
    expect(screen.queryByTestId("jev-summary")).toBe(null);
  });

  it("runが1つも無いときは、空の状態を表示する", async () => {
    stubFetch(buildFiles([]));
    renderAt("/jev");
    await screen.findByTestId("page-jev");
    expect((await screen.findByText(/runがありません/)).closest("[role=status]")?.textContent).toBe(
      "runがありません。Jevのrunを実行し、データを取り込んでください。",
    );
    expect(screen.queryByLabelText("run")).toBe(null);
  });

  it("runのファイルが読めないときは、エラーを表示する", async () => {
    const files = buildFiles(SPECS);
    delete files["/data/runs/run-c.json"];
    stubFetch(files);
    renderAt("/jev");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "ファイルがありません: ファイルが見つかりません: /data/runs/run-c.json(データを取り込み済みか確認してください)",
    );
  });
});
