import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFile, atomicWriteJson } from "./atomic-write";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atomic-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
  it("新規に書ける(親ディレクトリも作る)。一時ファイルは残らない", async () => {
    await atomicWriteFile(join(dir, "sub", "a.txt"), "hello");
    expect(await readFile(join(dir, "sub", "a.txt"), "utf8")).toBe("hello");
    expect(await readdir(join(dir, "sub"))).toEqual(["a.txt"]);
  });

  it("renameの直前で失敗しても、古い版のまま壊れず、一時ファイルも残らない", async () => {
    const target = join(dir, "result.json");
    await writeFile(target, '{"v":"old"}');
    await expect(
      atomicWriteFile(target, '{"v":"new"}', {
        rename: async () => {
          throw new Error("crash before rename");
        },
      }),
    ).rejects.toThrow("crash before rename");
    expect(await readFile(target, "utf8")).toBe('{"v":"old"}');
    expect(await readdir(dir)).toEqual(["result.json"]);
  });

  it("成功すれば、新しい版に置き換わる", async () => {
    const target = join(dir, "result.json");
    await writeFile(target, '{"v":"old"}');
    await atomicWriteJson(target, { v: "new" });
    expect(await readFile(target, "utf8")).toBe('{\n  "v": "new"\n}\n');
    expect(await readdir(dir)).toEqual(["result.json"]);
  });
});
