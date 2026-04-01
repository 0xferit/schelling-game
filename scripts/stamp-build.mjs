import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const backupDir = path.join(rootDir, '.stamp-build');
const targets = ['public/index.html', 'public/app.html'];

async function ensureBackupDirIsFresh() {
  try {
    await stat(backupDir);
    throw new Error(
      '.stamp-build already exists; run `npm run unstamp-build` before stamping again.',
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await mkdir(backupDir, { recursive: true });
      return;
    }
    throw error;
  }
}

function getBuildHash() {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8',
  }).trim();
}

function getBuildDate() {
  return `${new Date().toISOString().slice(0, 16)}Z`;
}

await ensureBackupDirIsFresh();

const replacements = {
  __BUILD_HASH__: getBuildHash(),
  __BUILD_DATE__: getBuildDate(),
};

for (const relativePath of targets) {
  const absolutePath = path.join(rootDir, relativePath);
  const original = await readFile(absolutePath, 'utf8');
  const backupPath = path.join(backupDir, path.basename(relativePath));
  await writeFile(backupPath, original, 'utf8');

  let stamped = original;
  for (const [placeholder, replacement] of Object.entries(replacements)) {
    stamped = stamped.replaceAll(placeholder, replacement);
  }
  await writeFile(absolutePath, stamped, 'utf8');
}
