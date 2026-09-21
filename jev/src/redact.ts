const MASK = "[REDACTED]";
const MAX_DEPTH = 64;

/** キーそのものと、よくあるエンコード(JSONエスケープ・URL・base64・base64url)の一覧。長い順(部分一致の取り残しを防ぐ)。 */
function variantsOf(secret: string): string[] {
  const set = new Set<string>([
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
  ]);
  set.delete("");
  return [...set].sort((a, b) => b.length - a.length);
}

/**
 * 応答・例外・構造化JSONを再帰的にたどり、文字列(とキー名)に含まれる秘密の値を伏せる。
 * 保存物・ログに出るものは、必ずこの関数を通す。循環参照は、打ち切って伏せる。
 */
export function redactSecrets<T>(value: T, secret: string): T {
  if (secret === "") return value;
  const variants = variantsOf(secret);
  const maskString = (s: string): string => variants.reduce((acc, v) => acc.split(v).join(MASK), s);
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return maskString(v);
    if (v === null || typeof v !== "object") return v;
    if (depth > MAX_DEPTH || seen.has(v)) return MASK;
    seen.add(v);
    const result = Array.isArray(v)
      ? v.map((x) => walk(x, depth + 1))
      : Object.fromEntries(Object.entries(v).map(([k, x]) => [maskString(k), walk(x, depth + 1)]));
    // 同じ許可済みrawを複数Resultが共有しても、循環ではない。現在の探索経路だけを検出する。
    seen.delete(v);
    return result;
  };
  return walk(value, 0) as T;
}
