import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { patchIsContract, readTronSource } from '../../plugins/tron-source.cjs';

test('preserves legacy Tron transformations, including nested calls', () => {
  assert.equal(
    patchIsContract('Address.isContract(IBeacon(newBeacon).implementation())'),
    '(IBeacon(newBeacon).implementation().code.length > 0)',
  );
  assert.equal(
    patchIsContract('recipient.isContract()'),
    '(recipient.code.length > 0)',
  );
  assert.equal(patchIsContract('uint256 value = 1;'), 'uint256 value = 1;');
});

test('reuses global patterns across sources without retaining match position', () => {
  const source = 'Address.isContract(target) || recipient.isContract()';
  const expected = '(target.code.length > 0) || (recipient.code.length > 0)';
  assert.equal(patchIsContract(source), expected);
  assert.equal(patchIsContract(source), expected);
});

test('reads overrides without mutating shared sources and sees override edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tron-source-'));
  try {
    await mkdir(join(root, 'overrides/tron'), { recursive: true });
    const originalPath = join(root, 'Mailbox.sol');
    await writeFile(originalPath, 'recipient.isContract()');
    assert.equal(
      await readTronSource(root, originalPath, () =>
        readFile(originalPath, 'utf8'),
      ),
      '(recipient.code.length > 0)',
    );
    assert.equal(
      await readFile(originalPath, 'utf8'),
      'recipient.isContract()',
    );
    const overridePath = join(root, 'overrides/tron/Create2.sol');
    const sourcePath = join(
      root,
      'dependencies/@openzeppelin-contracts-4.9.3/contracts/utils/Create2.sol',
    );
    const unexpectedRead = async (): Promise<string> => {
      throw new Error('Must read override');
    };
    await writeFile(overridePath, 'first override');
    assert.equal(
      await readTronSource(root, sourcePath, unexpectedRead),
      'first override',
    );
    await writeFile(overridePath, 'second override');
    assert.equal(
      await readTronSource(root, sourcePath, unexpectedRead),
      'second override',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
