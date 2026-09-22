import { ASPECT_IDS, OTHER_LABEL, STYLE_IDS } from "@oss-review-lab/shared";
import { DEFAULT_LABEL_VARIANT, LABEL_VARIANTS } from "../data/compose";
import type { LabelVariant } from "../data/compose";

/**
 * URLのクエリとlocalStorageの値を、解釈し、範囲を確認し、不正なら既定値に戻す共通関数。
 * 画面は、この結果だけを信頼する(生のクエリ文字列を直接使わない)。
 */

/** 除外(is_ack)の閾値の既定値。`/review/exclusion` と、一覧・詳細の返信の除外に使う。 */
export const DEFAULT_ACK_THRESHOLD = 0.8;
/** 観点・言い方のラベルの閾値の既定値。一覧・詳細に使う。除外の閾値とは、意味が違うので別。 */
export const DEFAULT_LABEL_THRESHOLD = 0.5;
export const DEFAULT_BAND = 0.1;

/** 発言者役割の絞り込み。all=全員、pr-author=PR作者、reviewer=PR作者以外。 */
export const ROLE_FILTERS = ["all", "pr-author", "reviewer"] as const;
export type RoleFilter = (typeof ROLE_FILTERS)[number];

/**
 * 一覧の並び順。既定(created)は、スレッド(親コメント)の時系列。explains-reasonは、
 * 「理由を説明している」確率が高い順(学びの大きいものを、埋もれさせないため)。
 */
export const SORT_ORDERS = ["created", "explains-reason"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];
export const DEFAULT_SORT: SortOrder = "created";

/** 観点の絞り込みで選べる値(「その他」を含む)。 */
export const ASPECT_FILTER_IDS: readonly string[] = [...ASPECT_IDS, OTHER_LABEL];
export const STYLE_FILTER_IDS: readonly string[] = [...STYLE_IDS, OTHER_LABEL];

export type ViewParams = {
  /** 除外の閾値(0〜1): is_ack の確率がこれ以上なら、返信を除外する(URLのクエリ `ackThreshold`) */
  ackThreshold: number;
  /** 観点・言い方のラベルの閾値(0〜1): 確率がこれ以上のものをラベルにする(URLのクエリ `labelThreshold`) */
  labelThreshold: number;
  /** 「要確認」の帯の幅(0〜1) */
  band: number;
  aspects: string[];
  styles: string[];
  role: RoleFilter;
  showExcluded: boolean;
  /** 観点・言い方の判定に使う variant(既定 parent-only)。is_ack は、常に reply */
  variant: LabelVariant;
  /** `/jev` で選んだrun。指定が無い(または不明な)ときは null(`/jev` は、既定のrunを使う) */
  run: string | null;
  /** 一覧の並び順(URLのクエリ `sort`) */
  sort: SortOrder;
};

export const DEFAULT_VIEW_PARAMS: ViewParams = {
  ackThreshold: DEFAULT_ACK_THRESHOLD,
  labelThreshold: DEFAULT_LABEL_THRESHOLD,
  band: DEFAULT_BAND,
  aspects: [],
  styles: [],
  role: "all",
  showExcluded: false,
  variant: DEFAULT_LABEL_VARIANT,
  run: null,
  sort: DEFAULT_SORT,
};

/** 10進の小数だけを許可し(空文字・空白・指数・16進・NaN・Infinityは不可)、0〜1に収まるものだけ返す。 */
export function parseProbability(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (!/^(\d+\.?\d*|\.\d+)$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/** 同じキーが2回以上あるクエリは曖昧なので、null(=既定値)にする。 */
function single(search: URLSearchParams, key: string): string | null {
  const all = search.getAll(key);
  return all.length === 1 ? (all[0] as string) : null;
}

function parseList(search: URLSearchParams, key: string, allowed: readonly string[]): string[] {
  const raw = single(search, key);
  if (raw === null || raw === "") return [];
  const out: string[] = [];
  for (const v of raw.split(",")) {
    if (allowed.includes(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

export type ParseContext = {
  /** Manifestにあるrunのid */
  knownRunIds: readonly string[];
  /** localStorageに保存された除外の閾値(無い・不正なら null) */
  storedAckThreshold: number | null;
  /** localStorageに保存された観点の閾値(無い・不正なら null) */
  storedLabelThreshold: number | null;
};

export function parseViewParams(search: URLSearchParams, ctx: ParseContext): ViewParams {
  const runRaw = single(search, "run");
  const roleRaw = single(search, "role");
  const variantRaw = single(search, "variant");
  const sortRaw = single(search, "sort");
  return {
    // URL > localStorage > 既定値(2つの閾値は、互いに独立)
    ackThreshold: parseProbability(single(search, "ackThreshold")) ?? ctx.storedAckThreshold ?? DEFAULT_ACK_THRESHOLD,
    labelThreshold:
      parseProbability(single(search, "labelThreshold")) ?? ctx.storedLabelThreshold ?? DEFAULT_LABEL_THRESHOLD,
    band: parseProbability(single(search, "band")) ?? DEFAULT_BAND,
    aspects: parseList(search, "aspects", ASPECT_FILTER_IDS),
    styles: parseList(search, "styles", STYLE_FILTER_IDS),
    role: ROLE_FILTERS.find((r) => r === roleRaw) ?? "all",
    showExcluded: single(search, "excluded") === "1",
    variant: LABEL_VARIANTS.find((v) => v === variantRaw) ?? DEFAULT_LABEL_VARIANT,
    run: runRaw !== null && ctx.knownRunIds.includes(runRaw) ? runRaw : null,
    sort: SORT_ORDERS.find((s) => s === sortRaw) ?? DEFAULT_SORT,
  };
}

/** 状態をクエリにする。既定値の項目は省く(2つの閾値は、共有した先で同じ表示になるよう常に出す)。 */
export function toSearchParams(p: ViewParams): URLSearchParams {
  const s = new URLSearchParams();
  s.set("ackThreshold", String(p.ackThreshold));
  s.set("labelThreshold", String(p.labelThreshold));
  if (p.band !== DEFAULT_BAND) s.set("band", String(p.band));
  if (p.aspects.length > 0) s.set("aspects", p.aspects.join(","));
  if (p.styles.length > 0) s.set("styles", p.styles.join(","));
  if (p.role !== "all") s.set("role", p.role);
  if (p.showExcluded) s.set("excluded", "1");
  if (p.variant !== DEFAULT_LABEL_VARIANT) s.set("variant", p.variant);
  if (p.run !== null) s.set("run", p.run);
  if (p.sort !== DEFAULT_SORT) s.set("sort", p.sort);
  return s;
}

/** 閾値の用途。用途ごとに、別のlocalStorageのキーに保存する。 */
export type ThresholdKind = "ack" | "label";

const THRESHOLD_KEYS: Record<ThresholdKind, string> = {
  ack: "oss-review-lab:ackThreshold",
  label: "oss-review-lab:labelThreshold",
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** localStorageが使えない(未定義・例外)環境では、無いものとして扱う。 */
export function defaultStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readStoredThreshold(
  kind: ThresholdKind,
  storage: StorageLike | undefined = defaultStorage(),
): number | null {
  if (storage === undefined) return null;
  try {
    return parseProbability(storage.getItem(THRESHOLD_KEYS[kind]));
  } catch {
    return null;
  }
}

export function writeStoredThreshold(
  kind: ThresholdKind,
  threshold: number,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(THRESHOLD_KEYS[kind], String(threshold));
  } catch {
    // 保存できなくても動く(既定値に戻るだけ)
  }
}
