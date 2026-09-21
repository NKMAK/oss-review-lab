import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findViolations } from './check-no-private';

const noContent = (_path: string): string => '';

describe('findViolations (純粋関数)', () => {
  it('data/ 配下の追跡ファイルを検出する', () => {
    expect(findViolations(['data/x.json', 'data/raw/prs_a_b.json', 'README.md'], noContent)).toEqual([
      { path: 'data/x.json', reason: 'data/ 配下のファイルが追跡されている' },
      { path: 'data/raw/prs_a_b.json', reason: 'data/ 配下のファイルが追跡されている' },
    ]);
  });

  it('shared/fixtures/data/ は data/ 検査の対象外', () => {
    expect(
      findViolations(['shared/fixtures/data/index.json', 'shared/fixtures/data/threads/threads.jsonl'], noContent),
    ).toEqual([]);
  });

  it('.env はどの階層でも検出する。.env.example は対象外', () => {
    expect(findViolations(['.env', 'jev/.env', 'a/b/.env', '.env.example'], noContent)).toEqual([
      { path: '.env', reason: '.env が追跡されている' },
      { path: 'jev/.env', reason: '.env が追跡されている' },
      { path: 'a/b/.env', reason: '.env が追跡されている' },
    ]);
  });

  it('fixtures 以外の *.jsonl を検出する', () => {
    expect(findViolations(['foo.jsonl', 'jev/out/x.jsonl', 'shared/fixtures/x.jsonl'], noContent)).toEqual([
      { path: 'foo.jsonl', reason: 'shared/fixtures 以外の *.jsonl が追跡されている' },
      { path: 'jev/out/x.jsonl', reason: 'shared/fixtures 以外の *.jsonl が追跡されている' },
    ]);
  });

  it('jev/pricing.json を検出する', () => {
    expect(findViolations(['jev/pricing.json'], noContent)).toEqual([
      { path: 'jev/pricing.json', reason: 'jev/pricing.json が追跡されている' },
    ]);
  });

  it('fixtures 内の本物のGitHub URLを検出する(fixtures/data/ も含む)', () => {
    const contents: Record<string, string> = {
      'shared/fixtures/a.json': '{"url":"https://github.com/nestjs/nest/pull/1"}',
      'shared/fixtures/data/b.json': '{"url":"https://api.github.com/repos/x"}',
      'shared/fixtures/ok.json': '{"url":"https://example.test/pull/1"}',
      'shared/src/c.ts': 'github.com/nestjs',
    };
    expect(findViolations(Object.keys(contents), (p) => contents[p] ?? '')).toEqual([
      { path: 'shared/fixtures/a.json', reason: 'fixtures に本物のGitHub URL (github.com/nestjs) を含む' },
      { path: 'shared/fixtures/data/b.json', reason: 'fixtures に本物のGitHub URL (api.github.com) を含む' },
    ]);
  });

  it('正常なリポジトリは通る', () => {
    expect(findViolations(['package.json', 'shared/fixtures/data/index.json', 'shared/src/a.ts'], noContent)).toEqual([]);
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
      stderr: 'check:private 失敗\n  data/x.json: data/ 配下のファイルが追跡されている\n',
    });
  });

  it('正常なリポジトリは終了コード0', () => {
    const r = run(setup({ 'shared/fixtures/data/i.json': '{}', 'a.txt': 'a' }));
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: 'check:private OK\n' });
  });

  it('.gitignore された data/ と .env は git status に出ない', () => {
    const dir = setup({ 'a.txt': 'a' }, 'data/\n.env\n');
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data/x.json'), '{}');
    writeFileSync(join(dir, '.env'), 'X=1');
    const out = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: dir, encoding: 'utf8' });
    expect(out).toBe('A  .gitignore\nA  a.txt\n');
  });
});
