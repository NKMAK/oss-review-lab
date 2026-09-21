import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { IsoUtcSchema } from "@oss-review-lab/shared";
import { z } from "zod";

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

export type IndexSource = { file: string; sha256: string; repo: string; fetchedAt: string };

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
export function importRaw({ from, dataDir }: ImportRawOptions): { imported: string[] } {
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

  const entries: IndexSource[] = [];
  for (const f of files) {
    writeFileAtomic(join(dataDir, "raw", f.name), f.buf);
    entries.push({ file: `raw/${f.name}`, sha256: sha256Hex(f.buf), repo: f.repo, fetchedAt: f.fetchedAt });
  }

  const existing = readIndexFile(dataDir) ?? {};
  const previous = Array.isArray(existing.sources) ? (existing.sources as IndexSource[]) : [];
  const replaced = new Set(entries.map((e) => e.file));
  const sources = [...previous.filter((s) => !replaced.has(s.file)), ...entries].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  );
  const next: Record<string, unknown> = { schemaVersion: 1, sources };
  if (existing.threads !== undefined) next.threads = existing.threads;
  if (existing.runs !== undefined) next.runs = existing.runs;
  writeFileAtomic(join(dataDir, "index.json"), `${JSON.stringify(next, null, 2)}\n`);

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
