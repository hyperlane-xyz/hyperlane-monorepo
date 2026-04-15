import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('CLI forwards Solana extraSigners into signer.sendAndConfirmTransaction', async () => {
  const source = await readFile(new URL('./transfer.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /sendAndConfirmTransaction\(\s*\{\s*\.\.\.tx\.transaction,\s*extraSigners:\s*tx\.extraSigners,\s*\}\s*\)/s,
  );
});
