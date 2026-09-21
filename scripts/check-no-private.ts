// コミット前の検査: 非公開データ(他人のコメント、Jevの出力、.env)が追跡されていないかを調べる。
// 検査ロジックは純粋関数 findViolations。gitの実行とファイル読み込みだけをCLI側に置く。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Violation = { path: string; reason: string };

const FIXTURES = 'shared/fixtures/';
const FIXTURES_DATA = 'shared/fixtures/data/';
const REAL_URL_MARKERS = ['github.com/nestjs', 'api.github.com'] as const;

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

export function findViolations(trackedPaths: string[], readContent: (path: string) => string): Violation[] {
  const out: Violation[] = [];
  for (const path of trackedPaths) {
    const inFixturesData = path.startsWith(FIXTURES_DATA);
    if (!inFixturesData && (path.startsWith('data/') || path.includes('/data/'))) {
      out.push({ path, reason: 'data/ 配下のファイルが追跡されている' });
    }
    if (basename(path) === '.env') {
      out.push({ path, reason: '.env が追跡されている' });
    }
    if (path.endsWith('.jsonl') && !path.startsWith(FIXTURES)) {
      out.push({ path, reason: 'shared/fixtures 以外の *.jsonl が追跡されている' });
    }
    if (path === 'jev/pricing.json') {
      out.push({ path, reason: 'jev/pricing.json が追跡されている' });
    }
    if (path.startsWith(FIXTURES)) {
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
