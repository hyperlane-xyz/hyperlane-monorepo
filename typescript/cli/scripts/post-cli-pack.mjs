#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';

const fileName = 'package.json';
const backupFileName = 'package.old.json';

async function restorePackageJson() {
  const currentDir = process.cwd();
  const packageJsonPath = path.join(currentDir, fileName);
  const backupPath = path.join(currentDir, backupFileName);

  try {
    await fs.access(backupPath);
  } catch (error) {
    console.error(`Backup file not found at ${backupPath}. Operation aborted.`);
    process.exit(1);
  }

  try {
    await fs.unlink(packageJsonPath);
    console.info(`Deleted existing "${fileName}" at ${packageJsonPath}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`No "${fileName}" found at ${packageJsonPath} to delete.`);
    } else {
      console.error(`Error deleting "${fileName}":`, error);
      process.exit(1);
    }
  }

  try {
    await fs.rename(backupPath, packageJsonPath);
    console.info(`Renamed "${backupFileName}" to "${fileName}"`);
  } catch (error) {
    console.error(
      `Error renaming "${backupFileName}" to "${fileName}":`,
      error,
    );
    process.exit(1);
  }
}

restorePackageJson();
