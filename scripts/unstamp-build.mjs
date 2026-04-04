import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const backupDir = path.join(rootDir, '.stamp-build');
const restoreTargets = new Map([
  ['index.html', path.join(rootDir, 'public', 'index.html')],
  ['app.html', path.join(rootDir, 'public', 'app.html')],
]);

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
  if (fileName.startsWith('.')) {
    continue;
  }

  const targetPath = restoreTargets.get(fileName);
  if (!targetPath) {
    continue;
  }

  const backupPath = path.join(backupDir, fileName);
  const original = await readFile(backupPath, 'utf8');
  await writeFile(targetPath, original, 'utf8');
}

await rm(backupDir, { recursive: true, force: true });
