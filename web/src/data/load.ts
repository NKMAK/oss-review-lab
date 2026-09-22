import { ManifestSchema, RunSchema, ThreadSchema } from "@oss-review-lab/shared";
import type { Manifest, Run, Thread } from "@oss-review-lab/shared";

/**
 * 失敗の種類。画面は、種類ごとに別のメッセージを出す。
 * - manifest-invalid: Manifest(index.json)のJSONが壊れている / スキーマに合わない
 * - not-found: ファイルが無い(404)、またはManifestに無いrun
 * - schema-mismatch: スレッド・Runのファイルがスキーマに合わない
 * - network: 通信の失敗、404以外のHTTPエラー
 */
export type DataErrorKind = "manifest-invalid" | "not-found" | "schema-mismatch" | "network";

export class DataLoadError extends Error {
  readonly kind: DataErrorKind;
  constructor(kind: DataErrorKind, message: string) {
    super(message);
    this.name = "DataLoadError";
    this.kind = kind;
  }
}

export type LoadedData = {
  manifest: Manifest;
  threads: Thread[];
  /** 整合の警告(hash・件数の不一致)。表示するが、止めない */
  warnings: string[];
  /** 既定のrun: 新しい順で最初の complete。無ければ、新しい順で最初のrun。runが無ければ null */
  defaultRunId: string | null;
};

const DATA_ROOT = "/data/";

async function fetchText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new DataLoadError("network", `${url} を取得できませんでした: ${errorMessage(e)}`);
  }
  if (res.status === 404) {
    throw new DataLoadError(
      "not-found",
      `ファイルが見つかりません: ${url}(データを取り込み済みか確認してください)`,
    );
  }
  if (!res.ok) {
    throw new DataLoadError("network", `${url} を取得できませんでした: HTTP ${res.status}`);
  }
  return res.text();
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function issues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join(".") || "(全体)"}: ${i.message}`).join(" / ");
}

export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return null; // 非セキュアなオリジンでは計算できない(警告を出さない)
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashWarning(file: string, text: string, expected: string): Promise<string[]> {
  const actual = await sha256Hex(text);
  if (actual === null || actual === expected) return [];
  return [`${file} のhashがManifestと一致しません(Manifest: ${expected}, 実ファイル: ${actual})`];
}

export async function loadManifest(): Promise<Manifest> {
  const url = `${DATA_ROOT}index.json`;
  const text = await fetchText(url);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new DataLoadError("manifest-invalid", `Manifest(${url})のJSONが壊れています: ${errorMessage(e)}`);
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new DataLoadError("manifest-invalid", `Manifest(${url})が不正です: ${issues(parsed.error)}`);
  }
  return parsed.data;
}

export function pickDefaultRunId(manifest: Manifest): string | null {
  const byNewest = [...manifest.runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return (byNewest.find((r) => r.status === "complete") ?? byNewest[0])?.runId ?? null;
}

/** Manifest → スレッド(JSONL)を読み、zodで検証する。 */
export async function loadData(): Promise<LoadedData> {
  const manifest = await loadManifest();
  const file = manifest.threads.file;
  const text = await fetchText(`${DATA_ROOT}${file}`);

  const threads: Thread[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).replace(/\r$/, "");
    if (line === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (e) {
      throw new DataLoadError("schema-mismatch", `${file} の${i + 1}行目のJSONが壊れています: ${errorMessage(e)}`);
    }
    const parsed = ThreadSchema.safeParse(json);
    if (!parsed.success) {
      throw new DataLoadError(
        "schema-mismatch",
        `${file} の${i + 1}行目がスキーマに合いません: ${issues(parsed.error)}`,
      );
    }
    threads.push(parsed.data);
  }

  const warnings = await hashWarning(file, text, manifest.threads.sha256);
  if (threads.length !== manifest.threads.count) {
    warnings.push(`${file} の件数(${threads.length})がManifestの件数(${manifest.threads.count})と一致しません`);
  }
  return { manifest, threads, warnings, defaultRunId: pickDefaultRunId(manifest) };
}

/** 選択されたrunを読み、zodで検証する。hash不一致は、エラーにせず警告を返す。 */
export async function loadRun(
  manifest: Manifest,
  runId: string,
): Promise<{ run: Run; warnings: string[] }> {
  const entry = manifest.runs.find((r) => r.runId === runId);
  if (entry === undefined) {
    throw new DataLoadError("not-found", `Manifestに run「${runId}」がありません`);
  }
  const text = await fetchText(`${DATA_ROOT}${entry.file}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new DataLoadError("schema-mismatch", `${entry.file} のJSONが壊れています: ${errorMessage(e)}`);
  }
  const parsed = RunSchema.safeParse(json);
  if (!parsed.success) {
    throw new DataLoadError("schema-mismatch", `${entry.file} がスキーマに合いません: ${issues(parsed.error)}`);
  }
  const run = parsed.data;
  const warnings: string[] = [];
  if (run.threadsSha256 !== manifest.threads.sha256) {
    warnings.push(
      `run「${run.runId}」の threadsSha256(${run.threadsSha256})がManifestのthreads(${manifest.threads.sha256})と一致しません。別のデータに対する結果かもしれません`,
    );
  }
  warnings.push(...(await hashWarning(entry.file, text, entry.sha256)));
  return { run, warnings };
}
