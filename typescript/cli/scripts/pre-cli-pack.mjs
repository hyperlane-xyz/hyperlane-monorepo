#!/usr/bin/env node
import path from 'path';

import { copyFile, readFile, writeFile } from 'fs/promises';

// Clear the following fields to avoid the package manager installing any dependencies
const fieldsToClear = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'bundleDependencies',
];

const fileName = 'package.json';

async function clearDependencies() {
  const baseDir = process.cwd();
  const packageJsonPath = path.join(baseDir, fileName);

  try {
    // Copy the current package.json so that it can be restored in the post pack hook
    const backupFilePath = path.join(baseDir, 'package.old.json');
    await copyFile(packageJsonPath, backupFilePath);
    console.log(`Backup created at: ${backupFilePath}`);

    const data = await readFile(packageJsonPath, 'utf8');
    const packageJsonData = JSON.parse(data);
    for (const field of fieldsToClear) {
      if (packageJsonData[field]) {
        packageJsonData[field] = {};
      } else {
        console.warn(
          `No field "${field}" found in "${fileName}" file at "${baseDir}"`,
        );
      }
    }

    // Dump the modified package.json file
    await writeFile(
      packageJsonPath,
      JSON.stringify(packageJsonData, null, 2),
      'utf8',
    );
    console.log(`Successfully updated the "${fileName}" for packing.`);
  } catch (error) {
    console.error(`Error processing file at ${packageJsonPath}:`, error);
    process.exit(1);
  }
}

await clearDependencies();
