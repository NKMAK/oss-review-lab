import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ResultSchema, type Result } from "@oss-review-lab/shared";
import { atomicWriteJson } from "./atomic-write";
import { pickAllowedRaw } from "./jev-client";

/** キーの順序に依存しない、決定的なJSON文字列。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("有限でない数値はハッシュできません");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 正規化済みstate(その他の内容も可)のcontent hash。 */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export type CacheKeyParts = {
  stateHash: string;
  questionDefHash: string;
  /** 応答の実際のモデル識別子 */
  model: string;
};

/** キー = state hash + 質問定義hash + 実際のモデル識別子。 */
export function cacheKey(parts: CacheKeyParts): string {
  return sha256Hex(canonicalJson([parts.stateHash, parts.questionDefHash, parts.model]));
}

const CacheEntrySchema = z.object({
  schemaVersion: z.literal(1),
  model: z.string(),
  result: ResultSchema,
});

export class ResultCache {
  constructor(private readonly dir: string) {}

  private pathFor(parts: CacheKeyParts): string {
    return join(this.dir, `${cacheKey(parts)}.json`);
  }

  /** ヒットすれば保存済みのResult。無ければ null。壊れていれば、ファイル名付きで止める。 */
  async get(parts: CacheKeyParts): Promise<Result | null> {
    const path = this.pathFor(parts);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`${path}: キャッシュがJSONとして読めません: ${(e as Error).message}`);
    }
    const parsed = CacheEntrySchema.safeParse(json);
    if (!parsed.success) throw new Error(`${path}: キャッシュの形式が不正です: ${parsed.error.message}`);
    return parsed.data.result;
  }

  /** 成功した結果だけを保存する(errorつきは拒否)。原子的に書く。 */
  async put(model: string, result: Result): Promise<void> {
    if (result.error !== null) throw new Error("errorつきの結果はキャッシュしません");
    const path = this.pathFor({
      stateHash: result.stateHash,
      questionDefHash: result.questionDefHash,
      model,
    });
    // 許可リストを通す(他人のコメント本文がエコーされていても、キャッシュに残さない)
    await atomicWriteJson(path, { schemaVersion: 1, model, result: { ...result, raw: pickAllowedRaw(result.raw) } });
  }
}
