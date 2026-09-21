import { afterEach, describe, expect, it, vi } from "vitest";
import manifestText from "../../../shared/fixtures/data/index.json?raw";
import runAckText from "../../../shared/fixtures/data/runs/run-20260921-ack.json?raw";
import runAspectsText from "../../../shared/fixtures/data/runs/run-20260921-aspects.json?raw";
import threadsText from "../../../shared/fixtures/data/threads/threads.jsonl?raw";
import { FIXTURE_FILES } from "../testing/fixtures";
import { DataLoadError, loadData, loadRun } from "./load";

const files = FIXTURE_FILES;

/** 外部境界(fetch)だけをモックする。値が number ならHTTPステータス、Error なら通信失敗。 */
function stubFetch(over: Record<string, string | number | Error> = {}) {
  const calls: string[] = [];
  const table: Record<string, string | number | Error> = { ...files, ...over };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const v = table[url];
      if (v === undefined) return new Response("not found", { status: 404 });
      if (v instanceof Error) throw v;
      if (typeof v === "number") return new Response("err", { status: v });
      return new Response(v, { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof DataLoadError) return { kind: e.kind, message: e.message };
    throw e;
  }
  throw new Error("失敗するはずが成功した");
}

const SHA_FIXTURE_THREADS = "e6bde7eedd6e6b38df68eebb9145d559ec47305ce6e8b4b3c5d570ba7d5ab5e3";

describe("loadData", () => {
  it("fixturesを読み込み、Manifest・スレッド・既定runを返す(警告なし)", async () => {
    const calls = stubFetch();
    const data = await loadData();
    expect(calls).toEqual(["/data/index.json", "/data/threads/threads.jsonl"]);
    expect(data.manifest).toEqual(JSON.parse(manifestText));
    expect(data.threads).toEqual(
      threadsText
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l)),
    );
    // 新しい順で最初の complete(partial の run-20260921-partial は選ばない)
    expect(data.defaultRunId).toBe("run-20260921-with-replies");
    expect(data.warnings).toEqual([]);
  });

  it("壊れたJSONのManifestは、manifest-invalid(原因つき)", async () => {
    stubFetch({ "/data/index.json": "{ broken" });
    const f = await failure(loadData());
    expect(f.kind).toBe("manifest-invalid");
    expect(f.message.startsWith("Manifest(/data/index.json)のJSONが壊れています: ")).toBe(true);
  });

  it("スキーマ不正なManifest(不正なfile)は、manifest-invalidで項目名を含む", async () => {
    const bad = JSON.parse(manifestText);
    bad.threads.file = "../x";
    stubFetch({ "/data/index.json": JSON.stringify(bad) });
    expect(await failure(loadData())).toEqual({
      kind: "manifest-invalid",
      message:
        "Manifest(/data/index.json)が不正です: threads.file: data/ 配下の相対パスだけを許可します(.. ・絶対パス・URLは不可)",
    });
  });

  it("Manifestが無い(404)なら、not-found", async () => {
    stubFetch({ "/data/index.json": 404 });
    expect(await failure(loadData())).toEqual({
      kind: "not-found",
      message: "ファイルが見つかりません: /data/index.json(データを取り込み済みか確認してください)",
    });
  });

  it("threadsのファイルが無いなら、not-found", async () => {
    stubFetch({ "/data/threads/threads.jsonl": 404 });
    expect(await failure(loadData())).toEqual({
      kind: "not-found",
      message:
        "ファイルが見つかりません: /data/threads/threads.jsonl(データを取り込み済みか確認してください)",
    });
  });

  it("通信失敗・5xxは network", async () => {
    stubFetch({ "/data/index.json": new Error("offline") });
    expect(await failure(loadData())).toEqual({
      kind: "network",
      message: "/data/index.json を取得できませんでした: offline",
    });
    stubFetch({ "/data/index.json": 500 });
    expect(await failure(loadData())).toEqual({
      kind: "network",
      message: "/data/index.json を取得できませんでした: HTTP 500",
    });
  });

  it("スレッドのスキーマ不一致は、schema-mismatch(ファイル・行番号・項目つき)", async () => {
    const lines = threadsText.split("\n").filter((l) => l !== "");
    const bad = JSON.parse(lines[1] as string);
    delete bad.path;
    lines[1] = JSON.stringify(bad);
    stubFetch({ "/data/threads/threads.jsonl": lines.join("\n") });
    const f = await failure(loadData());
    expect(f.kind).toBe("schema-mismatch");
    expect(f.message.startsWith("threads/threads.jsonl の2行目がスキーマに合いません: path: ")).toBe(true);
  });

  it("スレッドのJSONLに壊れた行があれば、schema-mismatch", async () => {
    stubFetch({ "/data/threads/threads.jsonl": "{oops\n" });
    const f = await failure(loadData());
    expect(f.kind).toBe("schema-mismatch");
    expect(f.message.startsWith("threads/threads.jsonl の1行目のJSONが壊れています: ")).toBe(true);
  });

  it("スレッドが0件でも読み込みは成功し、threadsは空(空状態の判定は呼び出し側)。hash不一致は警告", async () => {
    const m = JSON.parse(manifestText);
    m.threads.count = 0;
    stubFetch({ "/data/index.json": JSON.stringify(m), "/data/threads/threads.jsonl": "" });
    const data = await loadData();
    expect(data.threads).toEqual([]);
    expect(data.warnings).toEqual([
      `threads/threads.jsonl のhashがManifestと一致しません(Manifest: ${SHA_FIXTURE_THREADS}, 実ファイル: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855)`,
    ]);
  });

  it("threadsの件数がManifestと違うなら警告", async () => {
    const m = JSON.parse(manifestText);
    m.threads.count = 9;
    stubFetch({ "/data/index.json": JSON.stringify(m) });
    const data = await loadData();
    expect(data.warnings).toEqual([
      "threads/threads.jsonl の件数(5)がManifestの件数(9)と一致しません",
    ]);
  });

  it("runsが空なら既定runは null", async () => {
    const m = JSON.parse(manifestText);
    m.runs = [];
    stubFetch({ "/data/index.json": JSON.stringify(m) });
    expect((await loadData()).defaultRunId).toBe(null);
  });
});

describe("loadRun", () => {
  async function manifest() {
    stubFetch();
    return (await loadData()).manifest;
  }

  it("runを読み込む(警告なし)", async () => {
    const m = await manifest();
    const { run, warnings } = await loadRun(m, "run-20260921-aspects");
    expect(run).toEqual(JSON.parse(runAspectsText));
    expect(warnings).toEqual([]);
  });

  it("Manifestに無いrunは not-found", async () => {
    const m = await manifest();
    expect(await failure(loadRun(m, "nope"))).toEqual({
      kind: "not-found",
      message: "Manifestに run「nope」がありません",
    });
  });

  it("Runのスキーマ不一致は schema-mismatch", async () => {
    const m = await manifest();
    const bad = JSON.parse(runAckText);
    bad.status = "weird";
    stubFetch({ "/data/runs/run-20260921-ack.json": JSON.stringify(bad) });
    const f = await failure(loadRun(m, "run-20260921-ack"));
    expect(f.kind).toBe("schema-mismatch");
    expect(f.message.startsWith("runs/run-20260921-ack.json がスキーマに合いません: status: ")).toBe(true);
  });

  it("Runのthreads hashがManifestと不一致なら警告", async () => {
    const m = await manifest();
    const other = runAckText.replace(SHA_FIXTURE_THREADS, "f".repeat(64));
    stubFetch({ "/data/runs/run-20260921-ack.json": other });
    const { warnings } = await loadRun(m, "run-20260921-ack");
    expect(warnings).toEqual([
      `run「run-20260921-ack」の threadsSha256(${"f".repeat(64)})がManifestのthreads(${SHA_FIXTURE_THREADS})と一致しません。別のデータに対する結果かもしれません`,
      "runs/run-20260921-ack.json のhashがManifestと一致しません(Manifest: c75890ebbe801186c5ff7f17e2597841f4bb61a572a31bbfe0f08525195a3778, 実ファイル: 9fea5fcaacf3d14df55bf84e9845d5af966418432d46e5f06d9e18debb7e0590)",
    ]);
  });
});
