import { describe, expect, it } from "vitest";
import { CommentSchema, ThreadSchema } from "./thread";

const validComment = {
  id: "1001",
  role: "root",
  createdAt: "2026-01-01T00:00:00Z",
  author: "reviewer-dummy",
  authorKind: "human",
  isPrAuthor: false,
  body: "Dummy",
  url: "https://example.test/x",
};
const validThread = {
  schemaVersion: 1,
  threadId: "1001",
  repo: "example-org/example-repo",
  pr: { number: 1, url: "https://example.test/pr/1", title: "Dummy", authorLogin: null },
  path: "a.ts",
  diffHunk: "",
  comments: [validComment],
  excludedReason: null,
};

describe("ThreadSchema", () => {
  it("正しいスレッドを、そのまま受理する", () => {
    expect(ThreadSchema.parse(validThread)).toEqual(validThread);
  });
  it("prがnull、excludedReasonがparent-missingでも受理する", () => {
    const t = { ...validThread, pr: null, excludedReason: "parent-missing" };
    expect(ThreadSchema.parse(t)).toEqual(t);
  });
  it("必須項目(threadId)の欠落を拒否する", () => {
    const { threadId: _omit, ...rest } = validThread;
    expect(ThreadSchema.safeParse(rest).success).toBe(false);
  });
  it("schemaVersionが1以外なら拒否する", () => {
    expect(ThreadSchema.safeParse({ ...validThread, schemaVersion: 2 }).success).toBe(false);
  });
  it("数値のid(文字列でない)を拒否する", () => {
    expect(ThreadSchema.safeParse({ ...validThread, threadId: 1001 }).success).toBe(false);
  });
  it("未知のexcludedReasonを拒否する", () => {
    expect(ThreadSchema.safeParse({ ...validThread, excludedReason: "other" }).success).toBe(false);
  });
});

describe("CommentSchema", () => {
  it("削除済みユーザー(author: null, unknown, isPrAuthor: null)を受理する", () => {
    const c = { ...validComment, author: null, authorKind: "unknown", isPrAuthor: null };
    expect(CommentSchema.parse(c)).toEqual(c);
  });
  it("UTCでない・不正な日時を拒否する", () => {
    expect(CommentSchema.safeParse({ ...validComment, createdAt: "2026-01-01" }).success).toBe(false);
    expect(
      CommentSchema.safeParse({ ...validComment, createdAt: "2026-01-01T00:00:00+09:00" }).success,
    ).toBe(false);
  });
  it("未知のroleを拒否する", () => {
    expect(CommentSchema.safeParse({ ...validComment, role: "child" }).success).toBe(false);
  });
});
