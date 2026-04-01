import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const backupDir = path.join(rootDir, '.stamp-build');

let backupFiles;
try {
  backupFiles = await readdir(backupDir);
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    process.exit(0);
  }
  throw error;
}

for (const fileName of backupFiles) {
  const backupPath = path.join(backupDir, fileName);
  const targetPath = path.join(rootDir, 'public', fileName);
  const original = await readFile(backupPath, 'utf8');
  await writeFile(targetPath, original, 'utf8');
}

await rm(backupDir, { recursive: true, force: true });
