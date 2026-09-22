import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findViolations } from './check-no-private';

const noContent = (_path: string): string => '';

describe('findViolations (純粋関数)', () => {
  it('ルート直下の data/ 配下の追跡ファイルを検出する', () => {
    expect(findViolations(['data/x.json', 'data/raw/prs_a_b.json', 'README.md'], noContent)).toEqual([
      { path: 'data/x.json', reason: 'ルート直下の data/ 配下のファイルが追跡されている' },
      { path: 'data/raw/prs_a_b.json', reason: 'ルート直下の data/ 配下のファイルが追跡されている' },
    ]);
  });

  it('深い階層の data/ (web/src/data/、shared/fixtures/data/)は違反にならない', () => {
    expect(
      findViolations(
        ['web/src/data/load.ts', 'shared/fixtures/data/index.json', 'shared/fixtures/data/threads/threads.jsonl'],
        noContent,
      ),
    ).toEqual([]);
  });

  it('.env はどの階層でも検出する。.env.example は対象外', () => {
    expect(findViolations(['.env', 'jev/.env', 'a/b/.env', '.env.example'], noContent)).toEqual([
      { path: '.env', reason: '.env が追跡されている' },
      { path: 'jev/.env', reason: '.env が追跡されている' },
      { path: 'a/b/.env', reason: '.env が追跡されている' },
    ]);
  });

  it('ダミーの置き場所(shared/fixtures/、jev/test/fixtures/)以外の *.jsonl を検出する', () => {
    const reason = 'ダミーの置き場所(shared/fixtures/、jev/test/fixtures/)以外の *.jsonl が追跡されている';
    expect(
      findViolations(
        ['foo.jsonl', 'jev/src/x.jsonl', 'web/x.jsonl', 'shared/fixtures/x.jsonl', 'jev/test/fixtures/raw/x.jsonl'],
        noContent,
      ),
    ).toEqual([
      { path: 'foo.jsonl', reason },
      { path: 'jev/src/x.jsonl', reason },
      { path: 'web/x.jsonl', reason },
    ]);
  });

  it('jev/pricing.json を検出する', () => {
    expect(findViolations(['jev/pricing.json'], noContent)).toEqual([
      { path: 'jev/pricing.json', reason: 'jev/pricing.json が追跡されている' },
    ]);
  });

  it('ダミーの置き場所2か所の本物のGitHub URLを検出する', () => {
    const contents: Record<string, string> = {
      'shared/fixtures/a.json': '{"url":"https://github.com/nestjs/nest/pull/1"}',
      'shared/fixtures/data/b.json': '{"url":"https://api.github.com/repos/x"}',
      'jev/test/fixtures/raw/c.jsonl': '{"url":"https://github.com/nestjs/nest/pull/2"}',
      'jev/test/fixtures/d.json': '{"url":"https://api.github.com/repos/y"}',
      'shared/fixtures/ok.json': '{"url":"https://example.test/pull/1"}',
      'jev/test/fixtures/ok.json': '{"url":"https://example.test/pull/2"}',
      'shared/src/c.ts': 'github.com/nestjs',
    };
    expect(findViolations(Object.keys(contents), (p) => contents[p] ?? '')).toEqual([
      { path: 'shared/fixtures/a.json', reason: 'fixtures に本物のGitHub URL (github.com/nestjs) を含む' },
      { path: 'shared/fixtures/data/b.json', reason: 'fixtures に本物のGitHub URL (api.github.com) を含む' },
      { path: 'jev/test/fixtures/raw/c.jsonl', reason: 'fixtures に本物のGitHub URL (github.com/nestjs) を含む' },
      { path: 'jev/test/fixtures/d.json', reason: 'fixtures に本物のGitHub URL (api.github.com) を含む' },
    ]);
  });

  it('正常なリポジトリは通る', () => {
    expect(
      findViolations(
        [
          'package.json',
          'shared/fixtures/data/index.json',
          'shared/src/a.ts',
          'web/src/data/load.ts',
          'jev/test/fixtures/raw/x.jsonl',
        ],
        noContent,
      ),
    ).toEqual([]);
  });
});

describe('CLI (実gitリポジトリ)', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'check-no-private.ts');
  const tsxBin = join(dirname(cli), '..', 'node_modules', '.bin', 'tsx');
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const setup = (files: Record<string, string>, ignore = ''): string => {
    const dir = mkdtempSync(join(tmpdir(), 'check-private-'));
    dirs.push(dir);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(join(dir, '.gitignore'), ignore);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    git('add', '-A', '-f');
    return dir;
  };
  const run = (cwd: string) => spawnSync(tsxBin, [cli], { cwd, encoding: 'utf8' });

  it('追跡された data/x.json があると、パス付きで失敗する', () => {
    const r = run(setup({ 'data/x.json': '{}', 'a.txt': 'a' }));
    expect({ status: r.status, stderr: r.stderr }).toEqual({
      status: 1,
      stderr: 'check:private 失敗\n  data/x.json: ルート直下の data/ 配下のファイルが追跡されている\n',
    });
  });

  it('正常なリポジトリは終了コード0', () => {
    const r = run(setup({ 'shared/fixtures/data/i.json': '{}', 'a.txt': 'a' }));
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: 'check:private OK\n' });
  });

  it('深い階層の data/ とjev/test/fixtures/の *.jsonl は、追跡されていても通る', () => {
    const r = run(setup({ 'web/src/data/load.ts': 'x', 'jev/test/fixtures/raw/x.jsonl': '{}' }));
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: 'check:private OK\n' });
  });

  it('/data/ の .gitignore は、ルート直下の data/ と .env だけを無視し、web/src/data/ は無視しない', () => {
    const dir = setup({ 'a.txt': 'a' }, '/data/\n.env\n');
    mkdirSync(join(dir, 'data'));
    mkdirSync(join(dir, 'web/src/data'), { recursive: true });
    writeFileSync(join(dir, 'data/x.json'), '{}');
    writeFileSync(join(dir, '.env'), 'X=1');
    writeFileSync(join(dir, 'web/src/data/new.ts'), 'x');
    const out = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: dir, encoding: 'utf8' });
    expect(out).toBe('A  .gitignore\nA  a.txt\n?? web/src/data/new.ts\n');
  });
});
