import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ManifestSchema, ThreadSchema } from "@oss-review-lab/shared";
import type { Comment, ExcludedReason, Thread } from "@oss-review-lab/shared";
import {
  RawDataError,
  parsePrsFile,
  parseRcFile,
  parseSourceFileName,
  readIndexFile,
  resolveDataDir,
  sha256Hex,
  verifyRawSources,
  writeFileAtomic,
} from "./import-raw";
import type { RawComment, RawPr } from "./import-raw";
import { acquireLockSync } from "./ledger";

export type SourceComment = { repo: string; /** `<file>:<行番号>`(エラー表示用) */ source: string; raw: RawComment };
export type SourcePr = { repo: string; raw: RawPr };

const THREADS_FILE = "threads/threads.jsonl";

/** id(数字だけの文字列)を数値として比較する。 */
function compareId(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** createdAt昇順、同時刻はid昇順。 */
function compareByTimeAndId(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  const t = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return t !== 0 ? Math.sign(t) : compareId(a.id, b.id);
}

function prNumberOf(pullRequestUrl: string): number {
  // スキーマで「末尾が数字」を保証している
  return Number(/(\d+)$/.exec(pullRequestUrl)?.[1]);
}

function authorKindOf(user: RawComment["user"]): Comment["authorKind"] {
  if (user === null || user === undefined) return "unknown";
  return user.type === "Bot" ? "bot" : "human";
}

function excludedReasonOf(root: Comment | null): ExcludedReason | null {
  if (root === null) return "parent-missing";
  if (root.authorKind === "bot") return "bot-root";
  if (root.authorKind === "unknown") return "unknown-root";
  return null;
}

/**
 * レビューコメントを、親を単位とするスレッドにまとめる(純粋関数)。
 * 入力の破損(重複id・自己参照・循環・親子のPR不一致)は、RawDataErrorで停止する。
 */
export function buildThreads({ comments, prs }: { comments: SourceComment[]; prs: SourcePr[] }): Thread[] {
  const byId = new Map<string, SourceComment>();
  for (const c of comments) {
    const first = byId.get(c.raw.id);
    if (first !== undefined) {
      throw new RawDataError(`コメントid ${c.raw.id} が重複しています(${first.source} と ${c.source})`);
    }
    byId.set(c.raw.id, c);
  }

  const prByKey = new Map<string, RawPr>();
  for (const p of prs) prByKey.set(`${p.repo}#${p.raw.number}`, p.raw);

  // 親探索: rootId ごとにメンバーを集める。親が範囲外なら、その親のidを rootId とする。
  const groups = new Map<string, { missing: boolean; members: SourceComment[] }>();
  for (const start of comments) {
    const visited = new Set<string>([start.raw.id]);
    let cur = start;
    let rootId = start.raw.id;
    let missing = false;
    while (cur.raw.in_reply_to_id !== null && cur.raw.in_reply_to_id !== undefined) {
      const parentId = cur.raw.in_reply_to_id;
      if (visited.has(parentId)) {
        throw new RawDataError(`${start.source}: in_reply_to_id が自己参照・循環しています(id ${start.raw.id})`);
      }
      const parent = byId.get(parentId);
      if (parent === undefined) {
        rootId = parentId;
        missing = true;
        break;
      }
      if (parent.raw.pull_request_url !== cur.raw.pull_request_url) {
        throw new RawDataError(
          `${cur.source}: 返信(id ${cur.raw.id})と親(id ${parent.raw.id})でpull_request_urlが異なります(${cur.raw.pull_request_url} / ${parent.raw.pull_request_url})`,
        );
      }
      visited.add(parentId);
      cur = parent;
      rootId = parent.raw.id;
    }
    const group = groups.get(rootId);
    if (group === undefined) {
      groups.set(rootId, { missing, members: [start] });
    } else {
      const ref = group.members[0];
      if (missing && ref !== undefined && ref.raw.pull_request_url !== start.raw.pull_request_url) {
        throw new RawDataError(
          `${start.source}: 同じ親(id ${rootId})を指す返信(id ${start.raw.id})とid ${ref.raw.id}でpull_request_urlが異なります(${start.raw.pull_request_url} / ${ref.raw.pull_request_url})`,
        );
      }
      group.members.push(start);
    }
  }

  const threads = [...groups.entries()].map(([rootId, group]) => {
    const toComment = (sc: SourceComment, role: Comment["role"], pr: RawPr | undefined): Comment => {
      const login = sc.raw.user?.login ?? null;
      const prLogin = pr?.author?.login ?? null;
      return {
        id: sc.raw.id,
        role,
        createdAt: sc.raw.created_at,
        author: login,
        authorKind: authorKindOf(sc.raw.user),
        isPrAuthor: login !== null && prLogin !== null ? login.toLowerCase() === prLogin.toLowerCase() : null,
        body: sc.raw.body ?? "",
        url: sc.raw.html_url,
      };
    };

    const sorted = [...group.members].sort((a, b) =>
      compareByTimeAndId({ createdAt: a.raw.created_at, id: a.raw.id }, { createdAt: b.raw.created_at, id: b.raw.id }),
    );
    const head = sorted[0] as SourceComment; // グループは空にならない
    const rootSource = group.missing ? undefined : byId.get(rootId);
    const anchor = rootSource ?? head; // path/diffHunk・repo・PRの基準
    const pr = prByKey.get(`${anchor.repo}#${prNumberOf(anchor.raw.pull_request_url)}`);

    const built = sorted.map((sc) => toComment(sc, sc === rootSource ? "root" : "reply", pr));
    const rootComment = built.find((x) => x.role === "root") ?? null;

    const thread: Thread = {
      schemaVersion: 1,
      threadId: rootId,
      repo: anchor.repo,
      pr:
        pr === undefined
          ? null
          : { number: pr.number, url: pr.url, title: pr.title, authorLogin: pr.author?.login ?? null },
      path: anchor.raw.path ?? "",
      diffHunk: anchor.raw.diff_hunk ?? "",
      comments: built,
      excludedReason: excludedReasonOf(rootComment),
    };
    // 並び順: 親(親欠落なら最初の返信)のcreatedAt・id
    const sortKey = { createdAt: (rootSource ?? head).raw.created_at, id: rootId };
    return { thread, sortKey };
  });

  threads.sort((a, b) => compareByTimeAndId(a.sortKey, b.sortKey));
  return threads.map((t) => ThreadSchema.parse(t.thread));
}

/** `<dataDir>/raw/` の rc_*.jsonl と prs_*.json を読む。規則に合わないファイルはエラー。 */
export function readRawDir(dataDir: string): { comments: SourceComment[]; prs: SourcePr[] } {
  const rawDir = join(dataDir, "raw");
  let names: string[];
  try {
    names = readdirSync(rawDir).sort();
  } catch (e) {
    throw new RawDataError(`${rawDir}: 読めません。先に import-raw を実行してください(${(e as Error).message})`);
  }
  const comments: SourceComment[] = [];
  const prs: SourcePr[] = [];
  for (const name of names) {
    const { kind, repo } = parseSourceFileName(name);
    const text = readFileSync(join(rawDir, name), "utf8");
    if (kind === "rc") {
      for (const { line, comment } of parseRcFile(name, text)) {
        comments.push({ repo, source: `${name}:${line}`, raw: comment });
      }
    } else {
      for (const raw of parsePrsFile(name, text)) prs.push({ repo, raw });
    }
  }
  return { comments, prs };
}

/** 生データからスレッドを組み、`threads/threads.jsonl` と `index.json`(threads)を書く。 */
export function runBuildThreads({ dataDir }: { dataDir: string }): { count: number; sha256: string } {
  // import-raw・run と同じロックで直列化する
  const release = acquireLockSync(dataDir);
  try {
    return runBuildThreadsLocked({ dataDir });
  } finally {
    release();
  }
}

function runBuildThreadsLocked({ dataDir }: { dataDir: string }): { count: number; sha256: string } {
  verifyRawSources(dataDir);
  const threads = buildThreads(readRawDir(dataDir));
  const text = threads.map((t) => `${JSON.stringify(t)}\n`).join("");
  const sha256 = sha256Hex(text);

  const existing = readIndexFile(dataDir) ?? {};
  const manifest = ManifestSchema.parse({
    schemaVersion: 1,
    sources: existing.sources ?? [],
    threads: { file: THREADS_FILE, sha256, count: threads.length },
    runs: existing.runs ?? [],
  });

  writeFileAtomic(join(dataDir, THREADS_FILE), text);
  writeFileAtomic(join(dataDir, "index.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { count: threads.length, sha256 };
}

function main(): void {
  try {
    const { count, sha256 } = runBuildThreads({ dataDir: resolveDataDir() });
    console.log(`${count} スレッドを書きました(sha256: ${sha256})`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
