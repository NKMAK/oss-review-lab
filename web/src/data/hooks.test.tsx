import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifestText from "../../../shared/fixtures/data/index.json?raw";
import runAckText from "../../../shared/fixtures/data/runs/run-20260921-ack.json?raw";
import runAspectsText from "../../../shared/fixtures/data/runs/run-20260921-aspects.json?raw";
import threadsText from "../../../shared/fixtures/data/threads/threads.jsonl?raw";
import { useViewParams } from "../params/useViewParams";
import { DataProvider, useData, useRun } from "./DataContext";

const files: Record<string, string> = {
  "/data/index.json": manifestText,
  "/data/threads/threads.jsonl": threadsText,
  "/data/runs/run-20260921-ack.json": runAckText,
  "/data/runs/run-20260921-aspects.json": runAspectsText,
};

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const v = files[url];
      return Promise.resolve(v === undefined ? new Response("nf", { status: 404 }) : new Response(v));
    }),
  );
}

function Probe() {
  const [params, update] = useViewParams();
  const run = useRun(params.run);
  const location = useLocation();
  return (
    <div>
      <p data-testid="params">{JSON.stringify(params)}</p>
      <p data-testid="run">{run.status === "success" ? `${run.run.runId}:${run.run.results.length}` : run.status}</p>
      <p data-testid="search">{location.search}</p>
      <button onClick={() => update({ threshold: 0.8, run: "run-20260921-aspects" })}>change</button>
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

describe("useViewParams / useRun", () => {
  it("クエリが空なら、既定値(既定run)で、そのrunを読み込む", async () => {
    stubFetch();
    renderAt("/threads");
    expect((await screen.findByTestId("params")).textContent).toBe(
      '{"threshold":0.5,"band":0.1,"aspects":[],"styles":[],"role":"all","showExcluded":false,"run":"run-20260921-ack"}',
    );
    expect((await screen.findByText(/^run-20260921-ack:/)).textContent).toBe("run-20260921-ack:8");
  });

  it("localStorageの閾値を使う。不正なクエリは無視される", async () => {
    stubFetch();
    localStorage.setItem("oss-review-lab:threshold", "0.3");
    renderAt("/threads?threshold=1.5&run=nope");
    const p = JSON.parse((await screen.findByTestId("params")).textContent as string);
    expect(p.threshold).toBe(0.3);
    expect(p.run).toBe("run-20260921-ack");
  });

  it("更新すると、クエリが書き換わり、閾値がlocalStorageに保存され、runが読み直される", async () => {
    stubFetch();
    renderAt("/threads");
    fireEvent.click(await screen.findByText("change"));
    expect((await screen.findByTestId("search")).textContent).toBe("?threshold=0.8&run=run-20260921-aspects");
    expect(localStorage.getItem("oss-review-lab:threshold")).toBe("0.8");
    expect((await screen.findByText(/^run-20260921-aspects:/)).textContent).toBe("run-20260921-aspects:30");
  });
});
