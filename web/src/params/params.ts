import { ASPECT_IDS, OTHER_LABEL, STYLE_IDS } from "@oss-review-lab/shared";

/**
 * URLのクエリとlocalStorageの値を、解釈し、範囲を確認し、不正なら既定値に戻す共通関数。
 * 画面は、この結果だけを信頼する(生のクエリ文字列を直接使わない)。
 */

export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_BAND = 0.1;

/** 発言者役割の絞り込み。all=全員、pr-author=PR作者、reviewer=PR作者以外。 */
export const ROLE_FILTERS = ["all", "pr-author", "reviewer"] as const;
export type RoleFilter = (typeof ROLE_FILTERS)[number];

/** 観点の絞り込みで選べる値(「その他」を含む)。 */
export const ASPECT_FILTER_IDS: readonly string[] = [...ASPECT_IDS, OTHER_LABEL];
export const STYLE_FILTER_IDS: readonly string[] = [...STYLE_IDS, OTHER_LABEL];

export type ViewParams = {
  /** 観点・言い方・is_ack の閾値(0〜1) */
  threshold: number;
  /** 「要確認」の帯の幅(0〜1) */
  band: number;
  aspects: string[];
  styles: string[];
  role: RoleFilter;
  showExcluded: boolean;
  /** 選択中のrun。runが1つも無ければ null */
  run: string | null;
};

export const DEFAULT_VIEW_PARAMS: ViewParams = {
  threshold: DEFAULT_THRESHOLD,
  band: DEFAULT_BAND,
  aspects: [],
  styles: [],
  role: "all",
  showExcluded: false,
  run: null,
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
  /** 既定のrun(runが無ければ null) */
  defaultRun: string | null;
  /** localStorageに保存された閾値(無い・不正なら null) */
  storedThreshold: number | null;
};

export function parseViewParams(search: URLSearchParams, ctx: ParseContext): ViewParams {
  const runRaw = single(search, "run");
  const roleRaw = single(search, "role");
  return {
    // URL > localStorage > 既定値
    threshold: parseProbability(single(search, "threshold")) ?? ctx.storedThreshold ?? DEFAULT_THRESHOLD,
    band: parseProbability(single(search, "band")) ?? DEFAULT_BAND,
    aspects: parseList(search, "aspects", ASPECT_FILTER_IDS),
    styles: parseList(search, "styles", STYLE_FILTER_IDS),
    role: ROLE_FILTERS.find((r) => r === roleRaw) ?? "all",
    showExcluded: single(search, "excluded") === "1",
    run: runRaw !== null && ctx.knownRunIds.includes(runRaw) ? runRaw : ctx.defaultRun,
  };
}

/** 状態をクエリにする。既定値の項目は省く(閾値とrunは、共有した先で同じ表示になるよう常に出す)。 */
export function toSearchParams(p: ViewParams): URLSearchParams {
  const s = new URLSearchParams();
  s.set("threshold", String(p.threshold));
  if (p.band !== DEFAULT_BAND) s.set("band", String(p.band));
  if (p.aspects.length > 0) s.set("aspects", p.aspects.join(","));
  if (p.styles.length > 0) s.set("styles", p.styles.join(","));
  if (p.role !== "all") s.set("role", p.role);
  if (p.showExcluded) s.set("excluded", "1");
  if (p.run !== null) s.set("run", p.run);
  return s;
}

const THRESHOLD_KEY = "oss-review-lab:threshold";

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

export function readStoredThreshold(storage: StorageLike | undefined = defaultStorage()): number | null {
  if (storage === undefined) return null;
  try {
    return parseProbability(storage.getItem(THRESHOLD_KEY));
  } catch {
    return null;
  }
}

export function writeStoredThreshold(
  threshold: number,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(THRESHOLD_KEY, String(threshold));
  } catch {
    // 保存できなくても動く(既定値に戻るだけ)
  }
}
