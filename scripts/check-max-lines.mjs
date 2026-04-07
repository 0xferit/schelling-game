#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const DEFAULT_BASE_REF = 'origin/main';
const DEFAULT_LIMIT = 1000;
const GIT_BUFFER_LIMIT = 16 * 1024 * 1024;

function formatGitError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stderr =
    'stderr' in error && error.stderr
      ? Buffer.from(error.stderr).toString('utf8').trim()
      : '';
  return stderr || error.message;
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    maxBuffer: GIT_BUFFER_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function gitText(args) {
  return git(args, { encoding: 'utf8' }).trim();
}

function parseLimit(rawLimit) {
  if (rawLimit === undefined) {
    return DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `MAX_LINES_LIMIT must be a positive integer; received ${JSON.stringify(rawLimit)}.`,
    );
  }

  return parsed;
}

function parseChangedFiles(baseRevision) {
  const rawOutput = git([
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    '--diff-filter=AMR',
    baseRevision,
    'HEAD',
  ]);
  const tokens = rawOutput.toString('utf8').split('\0');

  if (tokens.at(-1) === '') {
    tokens.pop();
  }

  const changes = [];
  let index = 0;

  while (index < tokens.length) {
    const status = tokens[index++];
    if (!status) {
      continue;
    }

    if (status.startsWith('R')) {
      const previousPath = tokens[index++];
      const currentPath = tokens[index++];

      if (!previousPath || !currentPath) {
        throw new Error(`Malformed rename entry returned by git for status ${status}.`);
      }

      changes.push({
        basePath: previousPath,
        headPath: currentPath,
        status,
      });
      continue;
    }

    const path = tokens[index++];
    if (!path) {
      throw new Error(`Malformed diff entry returned by git for status ${status}.`);
    }

    changes.push({
      basePath: status === 'A' ? null : path,
      headPath: path,
      status,
    });
  }

  return changes;
}

function readBlob(revision, filePath) {
  return git(['show', `${revision}:${filePath}`]);
}

function isBinaryFile(content) {
  return content.includes(0);
}

function countLines(content) {
  if (content.length === 0) {
    return 0;
  }

  let lineCount = 0;
  for (const byte of content) {
    if (byte === 0x0a) {
      lineCount += 1;
    }
  }

  return content.at(-1) === 0x0a ? lineCount : lineCount + 1;
}

function main() {
  const baseRef = process.env.MAX_LINES_BASE_REF?.trim() || DEFAULT_BASE_REF;
  const limit = parseLimit(process.env.MAX_LINES_LIMIT);

  let mergeBase = '';
  try {
    mergeBase = gitText(['merge-base', baseRef, 'HEAD']);
  } catch (error) {
    throw new Error(
      `Unable to resolve a merge base between ${baseRef} and HEAD. Set MAX_LINES_BASE_REF to a valid commit or branch. ${formatGitError(error)}`,
    );
  }

  const changes = parseChangedFiles(mergeBase);
  const offenders = [];
  let checkedTextFiles = 0;
  let skippedBinaryFiles = 0;

  for (const change of changes) {
    let baseBlob = null;
    if (change.basePath) {
      baseBlob = readBlob(mergeBase, change.basePath);
    }

    const headBlob = readBlob('HEAD', change.headPath);

    if ((baseBlob && isBinaryFile(baseBlob)) || isBinaryFile(headBlob)) {
      skippedBinaryFiles += 1;
      continue;
    }

    checkedTextFiles += 1;

    const baseLines = baseBlob ? countLines(baseBlob) : 0;
    const headLines = countLines(headBlob);

    if (baseLines <= limit && headLines > limit) {
      offenders.push({
        baseLines,
        headLines,
        path: change.headPath,
      });
    }
  }

  const summary = `Checked ${checkedTextFiles} changed text file(s) against merge-base ${mergeBase.slice(0, 12)} with limit ${limit}.`;

  if (offenders.length === 0) {
    console.log(`${summary} No files crossed above ${limit} lines.`);
    if (skippedBinaryFiles > 0) {
      console.log(`Skipped ${skippedBinaryFiles} changed binary file(s).`);
    }
    return;
  }

  console.error(`${summary} ${offenders.length} file(s) crossed above ${limit} lines:`);
  for (const offender of offenders) {
    console.error(`- ${offender.path}: ${offender.baseLines} -> ${offender.headLines} lines`);
  }
  if (skippedBinaryFiles > 0) {
    console.error(`Skipped ${skippedBinaryFiles} changed binary file(s).`);
  }
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
