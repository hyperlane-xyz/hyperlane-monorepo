/**
 * Patches .isContract() calls in Solidity files for Tron compatibility.
 *
 * Handles two patterns:
 *   Address.isContract(expr) → (expr.code.length > 0)
 *   ident.isContract()       → (ident.code.length > 0)
 */
import { promises as fs } from 'fs';

// Matches Address.isContract(...) with up to one level of nested parens.
// Inner group: alternation of non-paren chars or single-depth paren groups.
// e.g. Address.isContract(IBeacon(newBeacon).implementation())
const ADDRESS_IS_CONTRACT =
  /Address\.isContract\(((?:[^()]*|\([^()]*\))*)\)/g;

// Matches ident.isContract() — the using-for library call pattern.
const IDENT_IS_CONTRACT = /([a-zA-Z_][a-zA-Z0-9_]*)\.isContract\(\)/g;

for (const file of process.argv.slice(2)) {
  const content = await fs.readFile(file, 'utf-8');
  const patched = content
    .replace(ADDRESS_IS_CONTRACT, '($1.code.length > 0)')
    .replace(IDENT_IS_CONTRACT, '($1.code.length > 0)');
  await fs.writeFile(file, patched);
}
