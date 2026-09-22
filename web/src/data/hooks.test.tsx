import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifestText from "../../../shared/fixtures/data/index.json?raw";
import { FIXTURE_FILES } from "../testing/fixtures";
import { useViewParams } from "../params/useViewParams";
import { DataProvider, useData, useResults, useRun } from "./DataContext";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(over: Record<string, string | undefined> = {}) {
  const files: Record<string, string | undefined> = { ...FIXTURE_FILES, ...over };
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(url);
      const v = files[url];
      return Promise.resolve(v === undefined ? new Response("nf", { status: 404 }) : new Response(v));
    }),
  );
  return calls;
}

function Probe() {
  const [params, update] = useViewParams();
  const results = useResults();
  const run = useRun(params.run ?? "run-20260921-ack");
  const location = useLocation();
  return (
    <div>
      <p data-testid="params">{JSON.stringify(params)}</p>
      <p data-testid="results">
        {results.status === "success"
          ? `success:${results.runIds.join(",")}:${results.results.length}:${results.warnings.length}`
          : results.status === "error"
            ? `error:${results.error.message}`
            : results.status}
      </p>
      <p data-testid="run">{run.status === "success" ? `${run.run.runId}:${run.run.results.length}` : run.status}</p>
      <p data-testid="search">{location.search}</p>
      <button onClick={() => update({ ackThreshold: 0.9 })}>ack</button>
      <button onClick={() => update({ labelThreshold: 0.3 })}>label</button>
      <button onClick={() => update({ run: "run-20260921-aspects" })}>run</button>
    </div>
  );
}

function Gate() {
  const state = useData();
  return state.status === "success" ? <Probe /> : <p>{state.status}</p>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DataProvider>
        <Gate />
      </DataProvider>
    </MemoryRouter>,
  );
}

const manifestWith = (fn: (m: { runs: { runId: string; status: string }[] }) => void) => {
  const m = JSON.parse(manifestText);
  fn(m);
  return JSON.stringify(m);
};

describe("useViewParams", () => {
  it("クエリが空なら、既定値(除外0.8・観点0.5・parent-only)", async () => {
    stubFetch();
    renderAt("/threads");
    expect((await screen.findByTestId("params")).textContent).toBe(
      '{"ackThreshold":0.8,"labelThreshold":0.5,"band":0.1,"aspects":[],"styles":[],"role":"all","showExcluded":false,"variant":"parent-only","run":null,"sort":"created"}',
    );
  });

  it("localStorageの2つの閾値を、別々に使う。不正なクエリは無視される", async () => {
    stubFetch();
    localStorage.setItem("oss-review-lab:ackThreshold", "0.6");
    localStorage.setItem("oss-review-lab:labelThreshold", "0.3");
    renderAt("/threads?ackThreshold=1.5&run=nope");
    const p = JSON.parse((await screen.findByTestId("params")).textContent as string);
    expect([p.ackThreshold, p.labelThreshold, p.run]).toEqual([0.6, 0.3, null]);
  });

  it("除外の閾値を更新しても、観点の閾値は変わらない(URLとlocalStorageの両方)。逆も同じ", async () => {
    stubFetch();
    renderAt("/threads");
    fireEvent.click(await screen.findByText("ack"));
    expect((await screen.findByTestId("search")).textContent).toBe("?ackThreshold=0.9&labelThreshold=0.5");
    expect(localStorage.getItem("oss-review-lab:ackThreshold")).toBe("0.9");
    expect(localStorage.getItem("oss-review-lab:labelThreshold")).toBe(null);

    fireEvent.click(screen.getByText("label"));
    expect(screen.getByTestId("search").textContent).toBe("?ackThreshold=0.9&labelThreshold=0.3");
    expect(localStorage.getItem("oss-review-lab:ackThreshold")).toBe("0.9");
    expect(localStorage.getItem("oss-review-lab:labelThreshold")).toBe("0.3");
  });

  it("runは、指定したときだけクエリに出る(/jev 用)", async () => {
    stubFetch();
    renderAt("/jev");
    fireEvent.click(await screen.findByText("run"));
    expect((await screen.findByTestId("search")).textContent).toBe(
      "?ackThreshold=0.8&labelThreshold=0.5&run=run-20260921-aspects",
    );
  });
});

describe("useResults", () => {
  it("completeの全runを読み、合成した結果を返す(partialのrunは読み込まない)", async () => {
    const calls = stubFetch();
    renderAt("/threads");
    // ack 8 + aspects 30 + with-replies 15(partial の3件は含めない)
    expect((await screen.findByText(/^success:/)).textContent).toBe(
      "success:run-20260921-ack,run-20260921-aspects,run-20260921-with-replies:53:0",
    );
    // (このテストの Probe が useRun でも ack を読むので、重複は除く)
    expect([...new Set(calls.filter((u) => u.startsWith("/data/runs/")))].sort()).toEqual([
      "/data/runs/run-20260921-ack.json",
      "/data/runs/run-20260921-aspects.json",
      "/data/runs/run-20260921-with-replies.json",
    ]);
  });

  it("読み込み中は loading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.startsWith("/data/runs/")
          ? new Promise<Response>(() => {})
          : Promise.resolve(new Response(FIXTURE_FILES[url] ?? "", { status: FIXTURE_FILES[url] === undefined ? 404 : 200 })),
      ),
    );
    renderAt("/threads");
    await screen.findByTestId("params");
    expect(screen.getByTestId("results").textContent).toBe("loading");
  });

  it("completeのrunが無ければ idle", async () => {
    stubFetch({
      "/data/index.json": manifestWith((m) => {
        m.runs = m.runs.filter((r) => r.status !== "complete");
      }),
    });
    renderAt("/threads");
    await screen.findByTestId("params");
    expect((await screen.findByText("idle")).textContent).toBe("idle");
  });

  it("1つでも読めないrunがあれば、どのrunが失敗したかを含む error", async () => {
    stubFetch({ "/data/runs/run-20260921-ack.json": "{ broken" });
    renderAt("/threads");
    expect((await screen.findByText(/^error:/)).textContent).toMatch(
      /^error:run-20260921-ack: runs\/run-20260921-ack\.json のJSONが壊れています: /,
    );
  });

  it("各runの警告(hash不一致など)を集めて返す", async () => {
    stubFetch({ "/data/runs/run-20260921-ack.json": FIXTURE_FILES["/data/runs/run-20260921-ack.json"]!.replace("jev-0.0.0-dummy", "other") });
    renderAt("/threads");
    expect((await screen.findByText(/^success:/)).textContent).toBe(
      "success:run-20260921-ack,run-20260921-aspects,run-20260921-with-replies:53:1",
    );
  });
});

describe("useRun(/jev用。run単位)", () => {
  it("指定したrunを読み込む", async () => {
    stubFetch();
    renderAt("/jev");
    expect((await screen.findByText(/^run-20260921-ack:/)).textContent).toBe("run-20260921-ack:8");
  });
});
