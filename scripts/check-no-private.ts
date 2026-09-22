// コミット前の検査: 非公開データ(他人のコメント、Jevの出力、.env)が追跡されていないかを調べる。
// 検査ロジックは純粋関数 findViolations。gitの実行とファイル読み込みだけをCLI側に置く。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Violation = { path: string; reason: string };

// ダミーデータの置き場所(2か所)。*.jsonl の許可と、本物のURLの検査の両方がこの範囲を使う
const DUMMY_DIRS = ['shared/fixtures/', 'jev/test/fixtures/'] as const;
const inDummyDir = (p: string): boolean => DUMMY_DIRS.some((d) => p.startsWith(d));
const REAL_URL_MARKERS = ['github.com/nestjs', 'api.github.com'] as const;

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

export function findViolations(trackedPaths: string[], readContent: (path: string) => string): Violation[] {
  const out: Violation[] = [];
  for (const path of trackedPaths) {
    // 対象はリポジトリ直下の data/ だけ(web/src/data/ などのソースは対象外)
    if (path.startsWith('data/')) {
      out.push({ path, reason: 'ルート直下の data/ 配下のファイルが追跡されている' });
    }
    if (basename(path) === '.env') {
      out.push({ path, reason: '.env が追跡されている' });
    }
    if (path.endsWith('.jsonl') && !inDummyDir(path)) {
      out.push({ path, reason: 'ダミーの置き場所(shared/fixtures/、jev/test/fixtures/)以外の *.jsonl が追跡されている' });
    }
    if (path === 'jev/pricing.json') {
      out.push({ path, reason: 'jev/pricing.json が追跡されている' });
    }
    if (inDummyDir(path)) {
      const content = readContent(path);
      for (const marker of REAL_URL_MARKERS) {
        if (content.includes(marker)) {
          out.push({ path, reason: `fixtures に本物のGitHub URL (${marker}) を含む` });
        }
      }
    }
  }
  return out;
}

function main(): void {
  const listed = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const paths = listed.split('\0').filter((p) => p !== '');
  const readContent = (path: string): string => {
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      // 追跡されているが作業ツリーから消えているファイルは、内容が無いので対象外
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    }
  };
  const violations = findViolations(paths, readContent);
  if (violations.length === 0) {
    console.log('check:private OK');
    return;
  }
  console.error('check:private 失敗');
  for (const v of violations) console.error(`  ${v.path}: ${v.reason}`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
