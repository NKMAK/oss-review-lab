import { randomBytes } from "node:crypto";
import { mkdir, rename as fsRename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** 外部境界の注入用(テストで、rename直前の失敗を再現する)。 */
export type AtomicWriteDeps = {
  rename?: (from: string, to: string) => Promise<void>;
};

/**
 * 一時ファイルに書いてから rename で置き換える。
 * 途中で失敗しても、対象ファイルは古い版か新しい版のどちらかで、壊れない。
 */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  deps: AtomicWriteDeps = {},
): Promise<void> {
  const rename = deps.rename ?? fsRename;
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, data, { flag: "wx" });
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
  deps: AtomicWriteDeps = {},
): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, deps);
}
