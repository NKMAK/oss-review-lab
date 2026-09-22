import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW_PARAMS,
  parseProbability,
  parseViewParams,
  readStoredThreshold,
  toSearchParams,
  writeStoredThreshold,
} from "./params";

type Ctx = { knownRunIds: string[]; storedAckThreshold: number | null; storedLabelThreshold: number | null };
const ctx: Ctx = {
  knownRunIds: ["run-a", "run-b"],
  storedAckThreshold: null,
  storedLabelThreshold: null,
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
  it("クエリが空なら、既定値を返す(除外の閾値0.8、観点の閾値0.5、variantはparent-only、runは未指定)", () => {
    expect(parse("")).toEqual({
      ackThreshold: 0.8,
      labelThreshold: 0.5,
      band: 0.1,
      aspects: [],
      styles: [],
      role: "all",
      showExcluded: false,
      variant: "parent-only",
      run: null,
      sort: "created",
    });
  });

  it("正しいクエリを全て解釈する", () => {
    expect(
      parse(
        "ackThreshold=0.9&labelThreshold=0.7&band=0.2&aspects=types,tests,other&styles=question&role=reviewer&excluded=1&variant=with-replies&run=run-b&sort=explains-reason",
      ),
    ).toEqual({
      ackThreshold: 0.9,
      labelThreshold: 0.7,
      band: 0.2,
      aspects: ["types", "tests", "other"],
      styles: ["question"],
      role: "reviewer",
      showExcluded: true,
      variant: "with-replies",
      run: "run-b",
      sort: "explains-reason",
    });
  });

  it("不明なsortは、既定(created)に戻す", () => {
    expect(parse("sort=unknown").sort).toBe("created");
    expect(parse("").sort).toBe("created");
  });

  it.each(["NaN", "1.5", "-1", "", "abc"])("閾値が %j なら、それぞれの既定値に戻す", (v) => {
    expect(parse(`ackThreshold=${v}`).ackThreshold).toBe(0.8);
    expect(parse(`labelThreshold=${v}`).labelThreshold).toBe(0.5);
  });

  it("閾値が不正でも、localStorageの値があればそれを使う。URLの正しい値が優先。2つは独立", () => {
    const stored = { storedAckThreshold: 0.6, storedLabelThreshold: 0.3 };
    expect(parse("ackThreshold=NaN&labelThreshold=NaN", stored)).toMatchObject({
      ackThreshold: 0.6,
      labelThreshold: 0.3,
    });
    expect(parse("ackThreshold=0.9&labelThreshold=0.2", stored)).toMatchObject({
      ackThreshold: 0.9,
      labelThreshold: 0.2,
    });
    expect(parse("", stored)).toMatchObject({ ackThreshold: 0.6, labelThreshold: 0.3 });
    // 片方だけURLにあっても、もう片方は変わらない
    expect(parse("ackThreshold=0.95", stored)).toMatchObject({ ackThreshold: 0.95, labelThreshold: 0.3 });
    expect(parse("labelThreshold=0.95", stored)).toMatchObject({ ackThreshold: 0.6, labelThreshold: 0.95 });
  });

  it("旧い `threshold` のクエリは、どちらの閾値にも使わない", () => {
    expect(parse("threshold=0.3")).toMatchObject({ ackThreshold: 0.8, labelThreshold: 0.5 });
  });

  it("重複した閾値のクエリは、既定値に戻す", () => {
    expect(parse("ackThreshold=0.2&ackThreshold=0.4").ackThreshold).toBe(0.8);
    expect(parse("labelThreshold=0.2&labelThreshold=0.4").labelThreshold).toBe(0.5);
  });

  it("variantは parent-only / with-replies だけ。それ以外(reply・不明・重複)は parent-only", () => {
    expect(parse("variant=with-replies").variant).toBe("with-replies");
    expect(parse("variant=reply").variant).toBe("parent-only");
    expect(parse("variant=xxx").variant).toBe("parent-only");
    expect(parse("variant=with-replies&variant=parent-only").variant).toBe("parent-only");
  });

  it("未知のrunは、未指定(null)に戻す。重複も未指定", () => {
    expect(parse("run=nope").run).toBe(null);
    expect(parse("run=run-b&run=run-a").run).toBe(null);
    expect(parse("run=../x").run).toBe(null);
    expect(parse("run=run-a").run).toBe("run-a");
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
      ackThreshold: 0.9,
      labelThreshold: 0.7,
      band: 0.2,
      aspects: ["types", "tests"],
      styles: ["question"],
      role: "pr-author" as const,
      showExcluded: true,
      variant: "with-replies" as const,
      run: "run-b",
      sort: "explains-reason" as const,
    };
    expect(toSearchParams(p).toString()).toBe(
      "ackThreshold=0.9&labelThreshold=0.7&band=0.2&aspects=types%2Ctests&styles=question&role=pr-author&excluded=1&variant=with-replies&run=run-b&sort=explains-reason",
    );
    expect(parse(toSearchParams(p).toString())).toEqual(p);
  });

  it("既定値の項目は出力しない(2つの閾値は常に出す)", () => {
    expect(toSearchParams(DEFAULT_VIEW_PARAMS).toString()).toBe("ackThreshold=0.8&labelThreshold=0.5");
    expect(toSearchParams({ ...DEFAULT_VIEW_PARAMS, run: "run-a" }).toString()).toBe(
      "ackThreshold=0.8&labelThreshold=0.5&run=run-a",
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

  it("除外の閾値と観点の閾値は、別のキーに保存し、別々に読み戻せる(片方を変えても、もう片方は変わらない)", () => {
    const s = fakeStorage();
    writeStoredThreshold("ack", 0.85, s);
    expect(s.data).toEqual({ "oss-review-lab:ackThreshold": "0.85" });
    expect(readStoredThreshold("ack", s)).toBe(0.85);
    expect(readStoredThreshold("label", s)).toBe(null);

    writeStoredThreshold("label", 0.35, s);
    expect(s.data).toEqual({
      "oss-review-lab:ackThreshold": "0.85",
      "oss-review-lab:labelThreshold": "0.35",
    });
    writeStoredThreshold("label", 0.4, s);
    expect(readStoredThreshold("ack", s)).toBe(0.85);
    expect(readStoredThreshold("label", s)).toBe(0.4);
  });

  it("旧いキー(oss-review-lab:threshold)は、どちらにも使わない", () => {
    const s = fakeStorage({ "oss-review-lab:threshold": "0.3" });
    expect(readStoredThreshold("ack", s)).toBe(null);
    expect(readStoredThreshold("label", s)).toBe(null);
  });

  it("不正な保存値は null", () => {
    expect(readStoredThreshold("ack", fakeStorage({ "oss-review-lab:ackThreshold": "9" }))).toBe(null);
    expect(readStoredThreshold("label", fakeStorage({ "oss-review-lab:labelThreshold": "NaN" }))).toBe(null);
    expect(readStoredThreshold("ack", fakeStorage())).toBe(null);
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
    expect(readStoredThreshold("ack", broken)).toBe(null);
    expect(() => writeStoredThreshold("ack", 0.4, broken)).not.toThrow();
    expect(readStoredThreshold("label", undefined)).toBe(null);
    expect(() => writeStoredThreshold("label", 0.4, undefined)).not.toThrow();
  });
});
