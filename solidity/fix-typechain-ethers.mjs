#!/usr/bin/env node
/**
 * Post-processes typechain factory JS files to fix ethers v5/v6 compat.
 *
 * The typechain ethers-v5 target generates `import { utils } from "ethers"`
 * and uses `new utils.Interface(_abi)`. The `utils` namespace re-export
 * causes webpack resolution failures in downstream apps that use Next.js
 * barrel optimization (optimizePackageImports) with webpackBuildWorker.
 *
 * This replaces the `utils` import with a direct `Interface` import from
 * `@ethersproject/abi` (already a peerDependency of @hyperlane-xyz/core).
 *
 * Usage: node fix-typechain-ethers.mjs <factoriesDir> [<factoriesDir2> ...]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('Usage: node fix-typechain-ethers.mjs <factoriesDir> [...]');
  process.exit(1);
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else if (path.endsWith('.js')) {
      files.push(path);
    }
  }
  return files;
}

let fixedCount = 0;
for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  for (const file of walk(dir)) {
    let content = readFileSync(file, 'utf8');
    if (!content.includes('utils')) continue;

    const original = content;

    // import { utils, Contract, ContractFactory[,] } from "ethers"
    // → import { Contract, ContractFactory } from "ethers" + Interface from @ethersproject/abi
    content = content.replace(
      /import \{ utils, (Contract, ContractFactory),? \} from "ethers";/,
      'import { $1 } from "ethers";\nimport { Interface } from "@ethersproject/abi";',
    );

    // import { Contract, utils } from "ethers"
    // → import { Contract } from "ethers" + Interface from @ethersproject/abi
    content = content.replace(
      /import \{ Contract, utils \} from "ethers";/,
      'import { Contract } from "ethers";\nimport { Interface } from "@ethersproject/abi";',
    );

    // utils.Interface → Interface
    content = content.replace(/new utils\.Interface\(_abi\)/g, 'new Interface(_abi)');

    if (content !== original) {
      writeFileSync(file, content);
      fixedCount++;
    }
  }
}

console.log(`Fixed ethers compat in ${fixedCount} typechain factories`);
