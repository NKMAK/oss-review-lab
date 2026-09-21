import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importRaw } from "./import-raw";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/raw");
const FIXED_MTIME = new Date("2026-02-03T04:05:06Z");

let work: string;
let from: string;
let dataDir: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "import-raw-"));
  from = join(work, "from");
  dataDir = join(work, "data");
  cpSync(FIXTURES, from, { recursive: true });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function setMtime(path: string): void {
  utimesSync(path, FIXED_MTIME, FIXED_MTIME);
}

function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("エラーが投げられませんでした");
}

const RC = "rc_example_repo.jsonl";
const PRS = "prs_example_repo.json";

function goodComment(id: number): string {
  return JSON.stringify({
    id,
    created_at: "2026-01-01T00:00:00Z",
    pull_request_url: "https://example.test/repos/example/repo/pulls/7",
    html_url: `https://example.test/example/repo/pull/7#discussion_r${id}`,
    body: "dummy",
  });
}

describe("importRaw: 正常系", () => {
  it("data/raw にコピーし、index.json の sources にhash・repo・更新時刻を記録する", () => {
    setMtime(join(from, RC));
    setMtime(join(from, PRS));

    importRaw({ from, dataDir });

    expect(readdirSync(join(dataDir, "raw")).sort()).toEqual([PRS, RC]);
    expect(readFileSync(join(dataDir, "raw", RC), "utf8")).toBe(readFileSync(join(FIXTURES, RC), "utf8"));
    expect(readFileSync(join(dataDir, "raw", PRS), "utf8")).toBe(readFileSync(join(FIXTURES, PRS), "utf8"));
    expect(JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      sources: [
        {
          file: "raw/prs_example_repo.json",
          sha256: "1954c78627ddd0e6bcdeb38a340ee9a11454c24c1efd1b55985263ffd7dae4bd",
          repo: "example/repo",
          fetchedAt: "2026-02-03T04:05:06Z",
        },
        {
          file: "raw/rc_example_repo.jsonl",
          sha256: "cd9c37008f18ae1c8fdffe203d9b35454dc08dd35ebd9c2aa686a48f008b931f",
          repo: "example/repo",
          fetchedAt: "2026-02-03T04:05:06Z",
        },
      ],
    });
    // 一時ファイルが残らない
    expect(readdirSync(dataDir).sort()).toEqual(["index.json", "raw"]);
  });

  it("repo名にアンダースコアを含むファイル名は、最初の _ でownerとrepoに分ける", () => {
    rmSync(join(from, PRS));
    rmSync(join(from, RC));
    writeFileSync(join(from, "prs_own-er_my_repo.json"), "[]");

    importRaw({ from, dataDir });

    expect(JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8")).sources.map((s: { repo: string }) => s.repo)).toEqual([
      "own-er/my_repo",
    ]);
  });

  it("再実行しても、既存のthreads/runsを保ち、同じfileのsourcesは置き換える", () => {
    importRaw({ from, dataDir });
    const index = JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8"));
    const withOthers = { ...index, threads: { file: "threads/threads.jsonl", sha256: "a".repeat(64), count: 0 }, runs: [] };
    writeFileSync(join(dataDir, "index.json"), JSON.stringify(withOthers));

    importRaw({ from, dataDir });

    const after = JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8"));
    expect(after.sources.length).toBe(2);
    expect(after.threads).toEqual({ file: "threads/threads.jsonl", sha256: "a".repeat(64), count: 0 });
    expect(after.runs).toEqual([]);
  });
});

describe("importRaw: 既存の index.json の検証と、更新の順序", () => {
  it("既存の index.json の sources が配列でなければ停止し、raw を更新しない(黙って空にしない)", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "index.json"), JSON.stringify({ schemaVersion: 1, sources: "broken", runs: [] }));
    const msg = errorMessage(() => importRaw({ from, dataDir }));
    expect(msg).toContain("index.json");
    expect(msg).toContain("sources");
    expect(existsSync(join(dataDir, "raw"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8")).sources).toBe("broken");
  });

  it("sources が無い(オブジェクトだが sources キー無し)既存の index.json も停止する", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "index.json"), JSON.stringify({ schemaVersion: 1, runs: [] }));
    expect(() => importRaw({ from, dataDir })).toThrow("sources");
    expect(existsSync(join(dataDir, "raw"))).toBe(false);
  });

  it("index.json の書き込み準備に失敗しても、raw は古い状態のまま残る", () => {
    importRaw({ from, dataDir }); // 最初の世代
    const before = readFileSync(join(dataDir, "raw", RC), "utf8");
    const indexBefore = readFileSync(join(dataDir, "index.json"), "utf8");
    writeFileSync(join(from, RC), `${goodComment(99)}\n`); // 新しい世代の内容
    // index.json の一時ファイルの場所を、ディレクトリで塞いで、準備に失敗させる
    mkdirSync(join(dataDir, `index.json.tmp-${process.pid}`));
    expect(() => importRaw({ from, dataDir })).toThrow();
    expect(readFileSync(join(dataDir, "raw", RC), "utf8")).toBe(before);
    expect(readFileSync(join(dataDir, "index.json"), "utf8")).toBe(indexBefore);
  });

  it("run が(ロックを持って)実行中なら、import-raw は拒否される。ロックは、終了時に解放される", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, ".lock"), JSON.stringify({ pid: process.pid, createdAt: "2026-09-22T00:00:00.000Z" }));
    expect(() => importRaw({ from, dataDir })).toThrow("二重起動は拒否します");
    expect(existsSync(join(dataDir, "raw"))).toBe(false);
    rmSync(join(dataDir, ".lock"));
    importRaw({ from, dataDir });
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
  });

  it("検証で失敗しても、ロックは解放される", () => {
    writeFileSync(join(from, RC), "{oops\n");
    expect(() => importRaw({ from, dataDir })).toThrow();
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
  });
});

describe("importRaw: 異常系(いずれも何もコピーせず停止)", () => {
  function expectNothingWritten(): void {
    expect(existsSync(join(dataDir, "raw"))).toBe(false);
    expect(existsSync(join(dataDir, "index.json"))).toBe(false);
  }

  it("壊れたJSONの行: 行番号つき", () => {
    writeFileSync(join(from, RC), `${goodComment(1)}\n{broken\n`);
    expect(errorMessage(() => importRaw({ from, dataDir }))).toBe(`${RC}:2: JSONとして解釈できません`);
    expectNothingWritten();
  });

  it("必須キー(html_url)の欠落: 行番号とキー名つき", () => {
    const { html_url: _omit, ...rest } = JSON.parse(goodComment(1));
    writeFileSync(join(from, RC), `${goodComment(2)}\n\n${JSON.stringify(rest)}\n`);
    expect(errorMessage(() => importRaw({ from, dataDir }))).toContain(`${RC}:3: html_url:`);
    expectNothingWritten();
  });

  it("不正な日時: 行番号とキー名つき", () => {
    const bad = { ...JSON.parse(goodComment(1)), created_at: "2026-13-45" };
    writeFileSync(join(from, RC), `${JSON.stringify(bad)}\n`);
    expect(errorMessage(() => importRaw({ from, dataDir }))).toContain(`${RC}:1: created_at:`);
    expectNothingWritten();
  });

  it("PR番号の重複: ファイル名と位置つき", () => {
    writeFileSync(
      join(from, PRS),
      JSON.stringify([
        { number: 7, title: "a", url: "https://example.test/pull/7", author: null },
        { number: 7, title: "b", url: "https://example.test/pull/7", author: null },
      ]),
    );
    expect(errorMessage(() => importRaw({ from, dataDir }))).toBe(`${PRS}[1]: PR番号 7 が重複しています(先頭は [0])`);
    expectNothingWritten();
  });

  it("規則に合わないファイル名: ファイル名つき", () => {
    writeFileSync(join(from, "notes.txt"), "x");
    expect(errorMessage(() => importRaw({ from, dataDir }))).toBe(
      "notes.txt: 対応していないファイル名です(rc_<owner>_<repo>.jsonl または prs_<owner>_<repo>.json だけを取り込めます)",
    );
    expectNothingWritten();
  });

  it("取り込み元が存在しない", () => {
    mkdirSync(dataDir, { recursive: true });
    expect(errorMessage(() => importRaw({ from: join(work, "nothing"), dataDir }))).toContain("取り込み元を読めません");
  });
});
