import {
  execFileSync,
  type SpawnSyncReturns,
  spawnSync,
} from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(
  new URL('../../scripts/check-max-lines.mjs', import.meta.url),
);
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function git(directory: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(directory: string, message: string) {
  git(directory, ['add', '.']);
  git(directory, ['commit', '--no-verify', '-m', message]);
}

function createRepository(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'check-max-lines-'));
  tempDirectories.push(directory);

  git(directory, ['init']);
  git(directory, ['config', 'user.name', 'Schelling Games Test']);
  git(directory, ['config', 'user.email', 'test@example.com']);

  return directory;
}

function lineContent(lineCount: number): string {
  if (lineCount === 0) {
    return '';
  }

  return Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`)
    .join('\n')
    .concat('\n');
}

function writeTextFile(
  directory: string,
  relativePath: string,
  lineCount: number,
) {
  const filePath = path.join(directory, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, lineContent(lineCount), 'utf8');
}

function writeBinaryFile(
  directory: string,
  relativePath: string,
  bytes: number[],
) {
  const filePath = path.join(directory, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.from(bytes));
}

function runCheck(
  directory: string,
  baseRef: string,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      MAX_LINES_BASE_REF: baseRef,
    },
    stdio: 'pipe',
  });
}

function combinedOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout}${result.stderr}`;
}

describe('check-max-lines script', () => {
  it('fails when a PR adds a new file above the line limit', () => {
    const directory = createRepository();
    writeTextFile(directory, 'README.md', 5);
    commitAll(directory, 'chore: create base');
    const baseRef = git(directory, ['rev-parse', 'HEAD']);

    writeTextFile(directory, 'src/generated.ts', 1001);
    commitAll(directory, 'feat: add generated file');

    const result = runCheck(directory, baseRef);

    expect(result.status).toBe(1);
    expect(combinedOutput(result)).toContain(
      'src/generated.ts: 0 -> 1001 lines',
    );
  });

  it('fails when a changed file grows from 1000 to 1001 lines', () => {
    const directory = createRepository();
    writeTextFile(directory, 'src/threshold.ts', 1000);
    commitAll(directory, 'chore: create base');
    const baseRef = git(directory, ['rev-parse', 'HEAD']);

    writeTextFile(directory, 'src/threshold.ts', 1001);
    commitAll(directory, 'feat: cross threshold');

    const result = runCheck(directory, baseRef);

    expect(result.status).toBe(1);
    expect(combinedOutput(result)).toContain(
      'src/threshold.ts: 1000 -> 1001 lines',
    );
  });

  it('allows edits to files that were already oversized in the base revision', () => {
    const directory = createRepository();
    writeTextFile(directory, 'src/already-large.ts', 1001);
    commitAll(directory, 'chore: create base');
    const baseRef = git(directory, ['rev-parse', 'HEAD']);

    writeTextFile(directory, 'src/already-large.ts', 1002);
    commitAll(directory, 'refactor: edit large file');

    const result = runCheck(directory, baseRef);

    expect(result.status).toBe(0);
    expect(combinedOutput(result)).toContain(
      'No files crossed above 1000 lines.',
    );
  });

  it('uses the pre-rename path from the base revision when evaluating renamed files', () => {
    const directory = createRepository();
    writeTextFile(directory, 'src/original.ts', 1000);
    commitAll(directory, 'chore: create base');
    const baseRef = git(directory, ['rev-parse', 'HEAD']);

    git(directory, ['mv', 'src/original.ts', 'src/renamed.ts']);
    writeTextFile(directory, 'src/renamed.ts', 1001);
    commitAll(directory, 'refactor: rename and grow file');

    const result = runCheck(directory, baseRef);

    expect(result.status).toBe(1);
    expect(combinedOutput(result)).toContain(
      'src/renamed.ts: 1000 -> 1001 lines',
    );
  });

  it('ignores binary changes and deletions', () => {
    const directory = createRepository();
    writeTextFile(directory, 'src/delete-me.ts', 1400);
    writeBinaryFile(directory, 'public/logo.bin', [0, 1, 2, 3]);
    commitAll(directory, 'chore: create base');
    const baseRef = git(directory, ['rev-parse', 'HEAD']);

    rmSync(path.join(directory, 'src/delete-me.ts'));
    writeBinaryFile(directory, 'public/logo.bin', [0, 1, 2, 3, 4, 5]);
    commitAll(directory, 'chore: binary only changes');

    const result = runCheck(directory, baseRef);

    expect(result.status).toBe(0);
    expect(combinedOutput(result)).toContain(
      'No files crossed above 1000 lines.',
    );
    expect(combinedOutput(result)).toContain(
      'Skipped 1 changed binary file(s).',
    );
  });
});
