import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Preserve source names, which are embedded in Solidity metadata.
const overrides = new Map([
  [
    'dependencies/@openzeppelin-contracts-4.9.3/contracts/utils/Create2.sol',
    'overrides/tron/Create2.sol',
  ],
  [
    'dependencies/@openzeppelin-contracts-4.9.3/contracts/token/ERC20/utils/SafeERC20.sol',
    'overrides/tron/SafeERC20.sol',
  ],
]);

export function patchIsContract(content: string): string {
  return content
    .replace(
      /Address\.isContract\(((?:[^()]*|\([^()]*\))*)\)/g,
      '($1.code.length > 0)',
    )
    .replace(
      /([a-zA-Z_][a-zA-Z0-9_]*)\.isContract\(\)/g,
      '($1.code.length > 0)',
    );
}

export async function readTronSource(
  root: string,
  absolutePath: string,
  readOriginal: () => Promise<string>,
): Promise<string> {
  for (const [source, replacement] of overrides) {
    if (absolutePath === resolve(root, source)) {
      return readFile(resolve(root, replacement), 'utf8');
    }
  }
  return patchIsContract(await readOriginal());
}
