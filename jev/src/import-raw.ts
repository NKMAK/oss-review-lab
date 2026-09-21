import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DataRelativePathSchema, IsoUtcSchema } from "@oss-review-lab/shared";
import { z } from "zod";
import { acquireLockSync } from "./ledger";

/** 入力データの破損・規則違反。メッセージに、ファイル名(と行番号)を含む。 */
export class RawDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawDataError";
  }
}

/** GitHubのIDは、数値でも文字列でも受け、文字列に揃える。 */
const IdSchema = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).transform((v) => String(v));

export const RawCommentSchema = z.object({
  id: IdSchema,
  created_at: IsoUtcSchema,
  /** 末尾がPR番号 */
  pull_request_url: z.string().regex(/\/\d+$/, "末尾がPR番号のURLではありません"),
  html_url: z.string(),
  body: z.string().nullable(),
  in_reply_to_id: IdSchema.nullish(),
  user: z.object({ login: z.string(), type: z.string() }).nullish(),
  path: z.string().nullish(),
  diff_hunk: z.string().nullish(),
});
export type RawComment = z.infer<typeof RawCommentSchema>;

export const RawPrSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  author: z.object({ login: z.string() }).nullish(),
});
export type RawPr = z.infer<typeof RawPrSchema>;

export type SourceFileKind = "rc" | "prs";
export type SourceFileName = { kind: SourceFileKind; repo: string };

const RC_NAME = /^rc_([^_/]+)_(.+)\.jsonl$/;
const PRS_NAME = /^prs_([^_/]+)_(.+)\.json$/;

export const UNSUPPORTED_NAME_MESSAGE =
  "対応していないファイル名です(rc_<owner>_<repo>.jsonl または prs_<owner>_<repo>.json だけを取り込めます)";

/** ファイル名から、種別とrepo(owner/repo)を決める。合わなければエラー。ownerは `_` を含まないので、最初の `_` で分ける。 */
export function parseSourceFileName(name: string): SourceFileName {
  const rc = RC_NAME.exec(name);
  if (rc) return { kind: "rc", repo: `${rc[1]}/${rc[2]}` };
  const prs = PRS_NAME.exec(name);
  if (prs) return { kind: "prs", repo: `${prs[1]}/${prs[2]}` };
  throw new RawDataError(`${name}: ${UNSUPPORTED_NAME_MESSAGE}`);
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join(".");
  return `${path === "" ? "(全体)" : path}: ${issue.message}`;
}

export type ParsedRcLine = { line: number; comment: RawComment };

/** `rc_*.jsonl` を1行ずつ検証する。空行は読み飛ばす(行番号は数える)。 */
export function parseRcFile(fileName: string, text: string): ParsedRcLine[] {
  const out: ParsedRcLine[] = [];
  text.split("\n").forEach((rawLine, i) => {
    const line = i + 1;
    if (rawLine.trim() === "") return;
    let json: unknown;
    try {
      json = JSON.parse(rawLine);
    } catch {
      throw new RawDataError(`${fileName}:${line}: JSONとして解釈できません`);
    }
    const parsed = RawCommentSchema.safeParse(json);
    if (!parsed.success) {
      throw new RawDataError(`${fileName}:${line}: ${parsed.error.issues.map(formatIssue).join(" / ")}`);
    }
    out.push({ line, comment: parsed.data });
  });
  return out;
}

/** `prs_*.json`(配列)を検証する。PR番号の重複はエラー。 */
export function parsePrsFile(fileName: string, text: string): RawPr[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RawDataError(`${fileName}: JSONとして解釈できません`);
  }
  if (!Array.isArray(json)) throw new RawDataError(`${fileName}: PRの配列ではありません`);
  const seen = new Map<number, number>();
  return json.map((item: unknown, i) => {
    const parsed = RawPrSchema.safeParse(item);
    if (!parsed.success) {
      throw new RawDataError(`${fileName}[${i}]: ${parsed.error.issues.map(formatIssue).join(" / ")}`);
    }
    const first = seen.get(parsed.data.number);
    if (first !== undefined) {
      throw new RawDataError(`${fileName}[${i}]: PR番号 ${parsed.data.number} が重複しています(先頭は [${first}])`);
    }
    seen.set(parsed.data.number, i);
    return parsed.data;
  });
}

/** 名前・内容を検証する(種別に応じて)。 */
export function validateSourceFile(fileName: string, text: string): SourceFileName {
  const kind = parseSourceFileName(fileName);
  if (kind.kind === "rc") parseRcFile(fileName, text);
  else parsePrsFile(fileName, text);
  return kind;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 一時ファイルに書いてから、renameで置き換える(原子的)。 */
export function writeFileAtomic(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

const SourceEntrySchema = z.object({
  file: DataRelativePathSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  repo: z.string(),
  fetchedAt: IsoUtcSchema,
});
export type IndexSource = z.infer<typeof SourceEntrySchema>;

/** index.json を読む。無ければnull。 */
export function readIndexFile(dataDir: string): Record<string, unknown> | null {
  const path = join(dataDir, "index.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RawDataError("index.json: JSONとして解釈できません");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new RawDataError("index.json: オブジェクトではありません");
  }
  return json as Record<string, unknown>;
}

/** 秒単位のISO 8601(UTC, 末尾Z)。 */
function toIsoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export type ImportRawOptions = { from: string; dataDir: string };

/**
 * `from` の rc_*.jsonl / prs_*.json を全て検証してから、`<dataDir>/raw/` にコピーし、
 * `<dataDir>/index.json` の `sources` に記録する。1つでも不正なら、何も書かずに停止する。
 */
export function importRaw(options: ImportRawOptions): { imported: string[] } {
  // run・build-threads と同じロックで直列化する(並行実行で更新を失わない)
  const release = acquireLockSync(options.dataDir);
  try {
    return importRawLocked(options);
  } finally {
    release();
  }
}

/**
 * 更新の順序: 検証(既存index含む) → 一時ファイルを全部書く(index、raw) → rawをrename → indexを最後にrename。
 * 準備の途中で失敗しても、古い一貫した状態(raw と index)が残る。
 */
function importRawLocked({ from, dataDir }: ImportRawOptions): { imported: string[] } {
  // 既存の index.json を先に検証する(壊れていたら、rawに触れずに停止。黙って空にしない)
  const existing = readIndexFile(dataDir);
  let previous: IndexSource[] = [];
  if (existing !== null) {
    const parsed = z.array(SourceEntrySchema).safeParse(existing.sources);
    if (!parsed.success) {
      throw new RawDataError(
        `index.json: sources が配列ではない(または形式が不正)ため停止します(手動で確認してください): ${parsed.error.issues.map(formatIssue).join(" / ")}`,
      );
    }
    previous = parsed.data;
  }

  let names: string[];
  try {
    names = readdirSync(from).sort();
  } catch (e) {
    throw new RawDataError(`${from}: 取り込み元を読めません(${(e as Error).message})`);
  }

  const files = names.map((name) => {
    const path = join(from, name);
    const buf = readFileSync(path);
    const { repo } = validateSourceFile(name, buf.toString("utf8"));
    return { name, buf, repo, fetchedAt: toIsoSeconds(statSync(path).mtime) };
  });

  const entries: IndexSource[] = files.map((f) => ({
    file: `raw/${f.name}`,
    sha256: sha256Hex(f.buf),
    repo: f.repo,
    fetchedAt: f.fetchedAt,
  }));
  const replaced = new Set(entries.map((e) => e.file));
  const sources = [...previous.filter((s) => !replaced.has(s.file)), ...entries].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  );
  const next: Record<string, unknown> = { schemaVersion: 1, sources };
  if (existing?.threads !== undefined) next.threads = existing.threads;
  if (existing?.runs !== undefined) next.runs = existing.runs;

  const rawDir = join(dataDir, "raw");
  const indexPath = join(dataDir, "index.json");
  const stagedIndex = `${indexPath}.tmp-${process.pid}`;
  const staged: Array<{ tmp: string; dest: string }> = [];
  try {
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(stagedIndex, `${JSON.stringify(next, null, 2)}\n`);
    for (const f of files) {
      const dest = join(rawDir, f.name);
      const tmp = join(rawDir, `.${f.name}.tmp-${process.pid}`);
      writeFileSync(tmp, f.buf);
      staged.push({ tmp, dest });
    }
    // ここまでで準備は完了。以降は rename だけ(rawを先に、indexを最後に)
    for (const s of staged) renameSync(s.tmp, s.dest);
    renameSync(stagedIndex, indexPath);
  } catch (e) {
    for (const p of [stagedIndex, ...staged.map((s) => s.tmp)]) rmSync(p, { force: true });
    throw e;
  }

  return { imported: files.map((f) => f.name) };
}

/** 環境変数 DATA_DIR(既定 ../data)。 */
export function resolveDataDir(): string {
  return resolve(process.env.DATA_DIR ?? "../data");
}

function main(argv: string[]): void {
  const i = argv.indexOf("--from");
  const from = i >= 0 ? argv[i + 1] : undefined;
  if (from === undefined || from.startsWith("--")) {
    console.error("使い方: pnpm --filter jev import-raw --from <dir>");
    process.exitCode = 1;
    return;
  }
  try {
    const { imported } = importRaw({ from: resolve(from), dataDir: resolveDataDir() });
    console.log(`${imported.length} ファイルを取り込みました: ${imported.join(", ")}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
