#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const GENERATED_DIR = 'src/providers/sealevel/generated';

// Recursively find all .ts files
function findTsFiles(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }

  return results;
}

// Check if an import path refers to a directory
function isDirectoryImport(fromFile, importPath) {
  const fromDir = dirname(fromFile);
  const resolvedPath = resolve(fromDir, importPath);

  try {
    return existsSync(resolvedPath) && statSync(resolvedPath).isDirectory();
  } catch {
    return false;
  }
}

// Find all TypeScript files in generated directory
const files = findTsFiles(GENERATED_DIR);

console.log(`🔧 Fixing import paths in ${files.length} generated files...\n`);

let totalFixed = 0;

for (const file of files) {
  let content = readFileSync(file, 'utf-8');
  let modified = false;
  let fileFixed = 0;

  // Fix relative imports: add .js extension or /index.js for directories
  // Pattern: from 'relative-path' where path doesn't end with .js
  content = content.replace(
    /from\s+['"](\.\.[\/a-zA-Z0-9_-]*|\.\/[a-zA-Z0-9_-]+|\.)['"]/g,
    (match, importPath) => {
      // Skip if already has .js extension
      if (importPath.endsWith('.js')) {
        return match;
      }

      modified = true;
      fileFixed++;

      // Check if this import refers to a directory
      if (isDirectoryImport(file, importPath)) {
        return `from '${importPath}/index.js'`;
      }

      // Otherwise it's a file import, add .js extension
      if (importPath === '.') {
        return `from './index.js'`;
      }

      return `from '${importPath}.js'`;
    }
  );

  if (modified) {
    writeFileSync(file, content, 'utf-8');
    totalFixed += fileFixed;
    const shortPath = file.replace(GENERATED_DIR + '/', '');
    console.log(`  ✅ Fixed ${fileFixed} imports in ${shortPath}`);
  }
}

console.log(`\n✨ Fixed ${totalFixed} import statements across ${files.length} files!`);
