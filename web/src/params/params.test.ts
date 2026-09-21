import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW_PARAMS,
  parseProbability,
  parseViewParams,
  readStoredThreshold,
  toSearchParams,
  writeStoredThreshold,
} from "./params";

type Ctx = { knownRunIds: string[]; defaultRun: string | null; storedThreshold: number | null };
const ctx: Ctx = {
  knownRunIds: ["run-a", "run-b"],
  defaultRun: "run-a",
  storedThreshold: null,
};

function parse(query: string, over: Partial<Ctx> = {}) {
  return parseViewParams(new URLSearchParams(query), { ...ctx, ...over });
}

describe("parseProbability", () => {
  it.each([
    ["0.3", 0.3],
    ["0", 0],
    ["1", 1],
    [".5", 0.5],
    ["NaN", null],
    ["1.5", null],
    ["-1", null],
    ["", null],
    [" ", null],
    ["Infinity", null],
    ["1e-1", null],
    ["0x1", null],
    ["abc", null],
    [null, null],
    [undefined, null],
  ])("%j -> %j", (raw, expected) => {
    expect(parseProbability(raw)).toBe(expected);
  });
});

describe("parseViewParams", () => {
  it("クエリが空なら、既定値(runは既定run)を返す", () => {
    expect(parse("")).toEqual({
      threshold: 0.5,
      band: 0.1,
      aspects: [],
      styles: [],
      role: "all",
      showExcluded: false,
      run: "run-a",
    });
  });

  it("正しいクエリを全て解釈する", () => {
    expect(
      parse("threshold=0.7&band=0.2&aspects=types,tests,other&styles=question&role=reviewer&excluded=1&run=run-b"),
    ).toEqual({
      threshold: 0.7,
      band: 0.2,
      aspects: ["types", "tests", "other"],
      styles: ["question"],
      role: "reviewer",
      showExcluded: true,
      run: "run-b",
    });
  });

  it.each(["NaN", "1.5", "-1", "", "abc"])("閾値が %j なら、既定値に戻す", (v) => {
    expect(parse(`threshold=${v}`).threshold).toBe(0.5);
  });

  it("閾値が不正でも、localStorageの値があればそれを使う。URLの正しい値が優先", () => {
    expect(parse("threshold=NaN", { storedThreshold: 0.3 }).threshold).toBe(0.3);
    expect(parse("threshold=0.9", { storedThreshold: 0.3 }).threshold).toBe(0.9);
    expect(parse("", { storedThreshold: 0.3 }).threshold).toBe(0.3);
  });

  it("重複した閾値のクエリは、既定値に戻す", () => {
    expect(parse("threshold=0.2&threshold=0.4").threshold).toBe(0.5);
  });

  it("未知のrunは、既定runに戻す。重複も既定", () => {
    expect(parse("run=nope").run).toBe("run-a");
    expect(parse("run=run-b&run=run-a").run).toBe("run-a");
    expect(parse("run=../x").run).toBe("run-a");
  });

  it("runが無い(既定runも無い)ときは null", () => {
    expect(parse("run=nope", { knownRunIds: [], defaultRun: null }).run).toBe(null);
  });

  it("未知の観点・言い方は捨て、重複は1つにする。重複クエリは空", () => {
    expect(parse("aspects=types,xxx,types").aspects).toEqual(["types"]);
    expect(parse("styles=question,yyy").styles).toEqual(["question"]);
    expect(parse("aspects=types&aspects=tests").aspects).toEqual([]);
  });

  it("未知の発言者役割・excludedは既定値", () => {
    expect(parse("role=admin").role).toBe("all");
    expect(parse("excluded=yes").showExcluded).toBe(false);
  });

  it("bandが不正なら既定値", () => {
    expect(parse("band=2").band).toBe(0.1);
  });
});

describe("toSearchParams", () => {
  it("解釈と往復して一致する", () => {
    const p = {
      threshold: 0.7,
      band: 0.2,
      aspects: ["types", "tests"],
      styles: ["question"],
      role: "pr-author" as const,
      showExcluded: true,
      run: "run-b",
    };
    expect(toSearchParams(p).toString()).toBe(
      "threshold=0.7&band=0.2&aspects=types%2Ctests&styles=question&role=pr-author&excluded=1&run=run-b",
    );
    expect(parse(toSearchParams(p).toString())).toEqual(p);
  });

  it("既定値の項目は出力しない(閾値とrunは常に出す)", () => {
    expect(toSearchParams({ ...DEFAULT_VIEW_PARAMS, run: null }).toString()).toBe("threshold=0.5");
    expect(toSearchParams({ ...DEFAULT_VIEW_PARAMS, run: "run-a" }).toString()).toBe(
      "threshold=0.5&run=run-a",
    );
  });
});

describe("localStorage", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
      data,
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
  }

  it("閾値を保存し、読み戻せる", () => {
    const s = fakeStorage();
    writeStoredThreshold(0.35, s);
    expect(s.data).toEqual({ "oss-review-lab:threshold": "0.35" });
    expect(readStoredThreshold(s)).toBe(0.35);
  });

  it("不正な保存値は null", () => {
    expect(readStoredThreshold(fakeStorage({ "oss-review-lab:threshold": "9" }))).toBe(null);
    expect(readStoredThreshold(fakeStorage({ "oss-review-lab:threshold": "NaN" }))).toBe(null);
    expect(readStoredThreshold(fakeStorage())).toBe(null);
  });

  it("localStorageが使えない(例外・undefined)でも落ちない", () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: (): void => {
        throw new Error("denied");
      },
    };
    expect(readStoredThreshold(broken)).toBe(null);
    expect(() => writeStoredThreshold(0.4, broken)).not.toThrow();
    expect(readStoredThreshold(undefined)).toBe(null);
    expect(() => writeStoredThreshold(0.4, undefined)).not.toThrow();
  });
});
