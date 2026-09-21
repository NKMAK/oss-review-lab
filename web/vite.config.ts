import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Connect, Plugin } from "vite";

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
};

/**
 * dev / preview で、データのディレクトリを `/data` として配信する。
 * 既定は `../data`(実データ)。`VITE_DATA_DIR` で切り替える(例: `../shared/fixtures/data`)。
 * 無いファイルは、SPAのフォールバックにせず、404を返す(画面が「ファイルなし」と判別できるように)。
 * 配信するのは .json / .jsonl だけで、ディレクトリの外は辿らせない。
 */
function dataDirPlugin(dataDir: string): Plugin {
  const root = resolve(dataDir);
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "", "http://localhost").pathname);
    } catch {
      pathname = "";
    }
    if (!pathname.startsWith("/data/")) return next();
    const file = resolve(root, "." + pathname.slice("/data".length));
    const type = CONTENT_TYPES[extname(file)];
    if (
      !file.startsWith(root + sep) ||
      type === undefined ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("not found");
      return;
    }
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-store");
    createReadStream(file).pipe(res);
  };
  return {
    name: "oss-review-lab:data-dir",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), dataDirPlugin(process.env.VITE_DATA_DIR ?? "../data")],
});
