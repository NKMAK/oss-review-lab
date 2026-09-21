import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ManifestSchema, ThreadSchema } from "@oss-review-lab/shared";
import type { Thread } from "@oss-review-lab/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildThreads, runBuildThreads } from "./build-threads";
import type { SourceComment, SourcePr } from "./build-threads";
import { importRaw } from "./import-raw";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/raw");

const PR7 = "https://example.test/repos/example/repo/pulls/7";
const PR8 = "https://example.test/repos/example/repo/pulls/8";

function c(
  id: number,
  over: {
    at?: string;
    reply?: number;
    pr?: string;
    user?: { login: string; type: string } | null;
    body?: string | null;
    path?: string;
    diff?: string;
  } = {},
): SourceComment {
  return {
    repo: "example/repo",
    source: `rc_example_repo.jsonl:${id}`,
    raw: {
      id: String(id),
      created_at: over.at ?? "2026-01-01T00:00:00Z",
      pull_request_url: over.pr ?? PR7,
      html_url: `https://example.test/c/${id}`,
      body: over.body === undefined ? `body ${id}` : over.body,
      in_reply_to_id: over.reply === undefined ? null : String(over.reply),
      user: over.user === undefined ? { login: "Rev", type: "User" } : over.user,
      path: over.path,
      diff_hunk: over.diff,
    },
  };
}

const PRS: SourcePr[] = [
  { repo: "example/repo", raw: { number: 7, title: "PR seven", url: "https://example.test/pr/7", author: { login: "Author" } } },
];

function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("エラーが投げられませんでした");
}

describe("buildThreads: スレッド構築(Unit)", () => {
  it("親1・返信2を、時系列順の1スレッドにまとめる", () => {
    const threads = buildThreads({
      comments: [
        c(3, { reply: 1, at: "2026-01-01T00:20:00Z" }),
        c(1, { at: "2026-01-01T00:00:00Z", path: "src/a.ts", diff: "@@ hunk" }),
        c(2, { reply: 1, at: "2026-01-01T00:10:00Z", user: { login: "AUTHOR", type: "User" } }),
      ],
      prs: PRS,
    });

    const comment = (id: string, role: "root" | "reply", at: string, author: string, isPrAuthor: boolean) => ({
      id,
      role,
      createdAt: at,
      author,
      authorKind: "human" as const,
      isPrAuthor,
      body: `body ${id}`,
      url: `https://example.test/c/${id}`,
    });
    const expected: Thread[] = [
      {
        schemaVersion: 1,
        threadId: "1",
        repo: "example/repo",
        pr: { number: 7, url: "https://example.test/pr/7", title: "PR seven", authorLogin: "Author" },
        path: "src/a.ts",
        diffHunk: "@@ hunk",
        comments: [
          comment("1", "root", "2026-01-01T00:00:00Z", "Rev", false),
          comment("2", "reply", "2026-01-01T00:10:00Z", "AUTHOR", true),
          comment("3", "reply", "2026-01-01T00:20:00Z", "Rev", false),
        ],
        excludedReason: null,
      },
    ];
    expect(threads).toEqual(expected);
  });

  it("同時刻のコメントはid昇順(数値として比較する)", () => {
    const threads = buildThreads({
      comments: [c(10, { reply: 9 }), c(9), c(100, { reply: 9 }), c(2, { reply: 9 })],
      prs: PRS,
    });
    expect(threads.map((t) => t.comments.map((x) => x.id))).toEqual([["2", "9", "10", "100"]]);
  });

  it("返信が返信を指す場合は、親まで辿って同じスレッドに入る", () => {
    const threads = buildThreads({
      comments: [c(1), c(2, { reply: 1, at: "2026-01-01T00:01:00Z" }), c(3, { reply: 2, at: "2026-01-01T00:02:00Z" })],
      prs: PRS,
    });
    expect(threads.map((t) => [t.threadId, t.comments.map((x) => `${x.id}:${x.role}`)])).toEqual([
      ["1", ["1:root", "2:reply", "3:reply"]],
    ]);
  });

  it("スレッドは、親のcreatedAt・id順に並ぶ", () => {
    const threads = buildThreads({
      comments: [
        c(30, { at: "2026-01-02T00:00:00Z" }),
        c(20, { at: "2026-01-01T00:00:00Z" }),
        c(5, { at: "2026-01-02T00:00:00Z" }),
        c(21, { reply: 30, at: "2025-12-31T00:00:00Z" }),
      ],
      prs: PRS,
    });
    expect(threads.map((t) => t.threadId)).toEqual(["20", "5", "30"]);
  });

  it("親が取得範囲に無い返信は、親のidをthreadIdとするparent-missingのスレッドになる", () => {
    const threads = buildThreads({
      comments: [
        c(2, { reply: 99, at: "2026-01-01T00:10:00Z", path: "src/x.ts", diff: "@@ x" }),
        c(3, { reply: 2, at: "2026-01-01T00:20:00Z" }),
      ],
      prs: PRS,
    });
    expect(threads).toEqual([
      {
        schemaVersion: 1,
        threadId: "99",
        repo: "example/repo",
        pr: { number: 7, url: "https://example.test/pr/7", title: "PR seven", authorLogin: "Author" },
        path: "src/x.ts",
        diffHunk: "@@ x",
        comments: [
          {
            id: "2",
            role: "reply",
            createdAt: "2026-01-01T00:10:00Z",
            author: "Rev",
            authorKind: "human",
            isPrAuthor: false,
            body: "body 2",
            url: "https://example.test/c/2",
          },
          {
            id: "3",
            role: "reply",
            createdAt: "2026-01-01T00:20:00Z",
            author: "Rev",
            authorKind: "human",
            isPrAuthor: false,
            body: "body 3",
            url: "https://example.test/c/3",
          },
        ],
        excludedReason: "parent-missing",
      },
    ]);
  });

  it("重複idはエラーで停止する(両方の位置を示す)", () => {
    expect(errorMessage(() => buildThreads({ comments: [c(1), { ...c(1), source: "other.jsonl:5" }], prs: PRS }))).toBe(
      "コメントid 1 が重複しています(rc_example_repo.jsonl:1 と other.jsonl:5)",
    );
  });

  it("自己参照はエラーで停止する", () => {
    expect(errorMessage(() => buildThreads({ comments: [c(1, { reply: 1 })], prs: PRS }))).toBe(
      "rc_example_repo.jsonl:1: in_reply_to_id が自己参照・循環しています(id 1)",
    );
  });

  it("循環(A→B→A)はエラーで停止する", () => {
    expect(errorMessage(() => buildThreads({ comments: [c(1, { reply: 2 }), c(2, { reply: 1 })], prs: PRS }))).toBe(
      "rc_example_repo.jsonl:1: in_reply_to_id が自己参照・循環しています(id 1)",
    );
  });

  it("親と返信でpull_request_urlが違う場合はエラーで停止する", () => {
    expect(errorMessage(() => buildThreads({ comments: [c(1), c(2, { reply: 1, pr: PR8 })], prs: PRS }))).toBe(
      `rc_example_repo.jsonl:2: 返信(id 2)と親(id 1)でpull_request_urlが異なります(${PR8} / ${PR7})`,
    );
  });

  it("同じ欠落親を指す返信同士でpull_request_urlが違う場合もエラーで停止する", () => {
    expect(errorMessage(() => buildThreads({ comments: [c(2, { reply: 99 }), c(3, { reply: 99, pr: PR8 })], prs: PRS }))).toBe(
      `rc_example_repo.jsonl:3: 同じ親(id 99)を指す返信(id 3)とid 2でpull_request_urlが異なります(${PR8} / ${PR7})`,
    );
  });

  it("PRが見つからない場合は pr:null、isPrAuthor:null", () => {
    const [t] = buildThreads({ comments: [c(1, { pr: PR8 })], prs: PRS });
    expect([t?.pr, t?.comments.map((x) => x.isPrAuthor)]).toEqual([null, [null]]);
  });

  it("PRのauthorが無い場合は authorLogin:null、isPrAuthor:null", () => {
    const [t] = buildThreads({
      comments: [c(1)],
      prs: [{ repo: "example/repo", raw: { number: 7, title: "t", url: "https://example.test/pr/7", author: null } }],
    });
    expect([t?.pr?.authorLogin, t?.comments.map((x) => x.isPrAuthor)]).toEqual([null, [null]]);
  });

  it("本文がnullなら空文字、親のpath/diffHunkが無ければ空文字", () => {
    const [t] = buildThreads({ comments: [c(1, { body: null })], prs: PRS });
    expect([t?.path, t?.diffHunk, t?.comments[0]?.body]).toEqual(["", "", ""]);
  });

  it("別リポジトリの同じPR番号を取り違えない", () => {
    const [t] = buildThreads({
      comments: [c(1)],
      prs: [{ repo: "other/repo", raw: { number: 7, title: "t", url: "https://example.test/o/7", author: { login: "x" } } }],
    });
    expect(t?.pr).toBe(null);
  });
});

describe("除外の判定(REQ-002)", () => {
  function one(root: SourceComment): Thread {
    const [t] = buildThreads({ comments: [root], prs: PRS });
    if (t === undefined) throw new Error("スレッドがありません");
    return t;
  }

  it("親がbotなら bot-root", () => {
    const t = one(c(1, { user: { login: "renovate[bot]", type: "Bot" } }));
    expect([t.excludedReason, t.comments[0]?.authorKind]).toEqual(["bot-root", "bot"]);
  });

  it("親のuserがnullなら unknown-root(author:null)", () => {
    const t = one(c(1, { user: null }));
    expect([t.excludedReason, t.comments[0]?.authorKind, t.comments[0]?.author, t.comments[0]?.isPrAuthor]).toEqual([
      "unknown-root",
      "unknown",
      null,
      null,
    ]);
  });

  it("親が人間なら、返信がbot・unknownでもスレッドは除外しない", () => {
    const [t] = buildThreads({
      comments: [
        c(1),
        c(2, { reply: 1, user: { login: "b[bot]", type: "Bot" } }),
        c(3, { reply: 1, user: null }),
      ],
      prs: PRS,
    });
    expect([t?.excludedReason, t?.comments.map((x) => x.authorKind)]).toEqual([null, ["human", "bot", "unknown"]]);
  });

  it("isPrAuthor は大文字小文字を区別せず比較する", () => {
    const [t] = buildThreads({
      comments: [c(1, { user: { login: "AUTHOR", type: "User" } }), c(2, { reply: 1, user: { login: "someone", type: "User" } })],
      prs: PRS,
    });
    expect(t?.comments.map((x) => x.isPrAuthor)).toEqual([true, false]);
  });
});

describe("runBuildThreads: ファイル入出力(Integration)", () => {
  let work: string;
  let dataDir: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "build-threads-"));
    dataDir = join(work, "data");
    cpSync(FIXTURES, join(dataDir, "raw"), { recursive: true });
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const EXPECTED_LINES = [
    {
      schemaVersion: 1,
      threadId: "1001",
      repo: "example/repo",
      pr: { number: 7, url: "https://example.test/example/repo/pull/7", title: "dummy PR 7", authorLogin: "author1" },
      path: "src/a.ts",
      diffHunk: "@@ -1 +1 @@\n-old\n+new",
      comments: [
        {
          id: "1001",
          role: "root",
          createdAt: "2026-01-01T00:00:00Z",
          author: "Reviewer1",
          authorKind: "human",
          isPrAuthor: false,
          body: "dummy root",
          url: "https://example.test/example/repo/pull/7#discussion_r1001",
        },
        {
          id: "1002",
          role: "reply",
          createdAt: "2026-01-01T00:10:00Z",
          author: "Author1",
          authorKind: "human",
          isPrAuthor: true,
          body: "dummy reply 1",
          url: "https://example.test/example/repo/pull/7#discussion_r1002",
        },
        {
          id: "1003",
          role: "reply",
          createdAt: "2026-01-01T00:20:00Z",
          author: "ci-bot[bot]",
          authorKind: "bot",
          isPrAuthor: false,
          body: "dummy reply 2 (bot)",
          url: "https://example.test/example/repo/pull/7#discussion_r1003",
        },
      ],
      excludedReason: null,
    },
    {
      schemaVersion: 1,
      threadId: "2001",
      repo: "example/repo",
      pr: { number: 8, url: "https://example.test/example/repo/pull/8", title: "dummy PR 8", authorLogin: null },
      path: "src/b.ts",
      diffHunk: "@@ -2 +2 @@",
      comments: [
        {
          id: "2001",
          role: "root",
          createdAt: "2026-01-02T00:00:00Z",
          author: null,
          authorKind: "unknown",
          isPrAuthor: null,
          body: "",
          url: "https://example.test/example/repo/pull/8#discussion_r2001",
        },
      ],
      excludedReason: "unknown-root",
    },
  ];

  it("fixturesから threads.jsonl と index.json を書く", () => {
    const result = runBuildThreads({ dataDir });

    const text = readFileSync(join(dataDir, "threads", "threads.jsonl"), "utf8");
    expect(text).toBe(EXPECTED_LINES.map((l) => `${JSON.stringify(l)}\n`).join(""));
    expect(result.count).toBe(2);
    const index = JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8"));
    expect(index).toEqual({
      schemaVersion: 1,
      sources: [],
      threads: { file: "threads/threads.jsonl", sha256: result.sha256, count: 2 },
      runs: [],
    });
  });

  it("契約: 出力の各行がThreadSchemaを満たし、index.jsonがManifestSchemaを満たす", () => {
    runBuildThreads({ dataDir });

    const lines = readFileSync(join(dataDir, "threads", "threads.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines.map((l) => ThreadSchema.safeParse(JSON.parse(l)).success)).toEqual([true, true]);
    expect(ManifestSchema.safeParse(JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8"))).success).toBe(true);
  });

  it("決定性: 2回実行して、バイト列とhashが完全に一致する", () => {
    const first = runBuildThreads({ dataDir });
    const bytes1 = readFileSync(join(dataDir, "threads", "threads.jsonl"));
    const second = runBuildThreads({ dataDir });
    const bytes2 = readFileSync(join(dataDir, "threads", "threads.jsonl"));

    expect(bytes2.equals(bytes1)).toBe(true);
    expect(second).toEqual(first);
  });

  it("import-raw が書いたsourcesと、既存のruns・sourcesを保つ", () => {
    importRaw({ from: FIXTURES, dataDir: join(work, "data2") });
    cpSync(join(work, "data2", "raw"), join(dataDir, "raw"), { recursive: true });
    cpSync(join(work, "data2", "index.json"), join(dataDir, "index.json"));
    const before = JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8"));

    runBuildThreads({ dataDir });

    const after = JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8"));
    expect(after.sources).toEqual(before.sources);
    expect(after.runs).toEqual([]);
  });

  it("規則に合わないファイルがdata/rawにあれば、ファイル名つきで停止する", () => {
    writeFileSync(join(dataDir, "raw", "memo.txt"), "x");
    expect(errorMessage(() => runBuildThreads({ dataDir }))).toBe(
      "memo.txt: 対応していないファイル名です(rc_<owner>_<repo>.jsonl または prs_<owner>_<repo>.json だけを取り込めます)",
    );
  });

  it("重複idはファイルをまたいでも、エラーで停止し、出力を書かない", () => {
    cpSync(join(dataDir, "raw", "rc_example_repo.jsonl"), join(dataDir, "raw", "rc_other_repo.jsonl"));
    expect(errorMessage(() => runBuildThreads({ dataDir }))).toContain("が重複しています");
    expect(() => readFileSync(join(dataDir, "threads", "threads.jsonl"))).toThrow();
  });
});
