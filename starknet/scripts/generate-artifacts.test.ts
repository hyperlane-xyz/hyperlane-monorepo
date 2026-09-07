import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { StarknetArtifactGenerator } from './StarknetArtifactGenerator.js';

test('worker output matches serial artifact generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'starknet-artifacts-'));
  try {
    const input = join(root, 'contracts_example.compiled_contract_class.json');
    await writeFile(input, JSON.stringify({ bytecode: ['0x1'], hints: [] }));
    const sierraInput = join(root, 'contracts_example.contract_class.json');
    await writeFile(
      sierraInput,
      JSON.stringify({
        sierra_program: ['0x1'],
        contract_class_version: '0.1.0',
        entry_points_by_type: { EXTERNAL: [], L1_HANDLER: [], CONSTRUCTOR: [] },
        abi: [],
      }),
    );
    const serial = new StarknetArtifactGenerator(
      root,
      join(root, 'serial/artifacts'),
    );
    await serial.createOutputDirectory();
    await serial.processArtifact(input);
    await serial.processArtifact(sierraInput);
    const parallel = new StarknetArtifactGenerator(
      root,
      join(root, 'parallel/artifacts'),
    );
    assert.equal((await parallel.generate()).size, 1);
    for (const extension of ['js', 'd.ts']) {
      for (const file of [
        `artifacts/contracts_example.compiled_contract_class.${extension}`,
        `artifacts/contracts_example.contract_class.${extension}`,
        `runtime-artifacts/contracts_example.${extension}`,
      ]) {
        assert.equal(
          await readFile(join(root, 'serial', file), 'utf8'),
          await readFile(join(root, 'parallel', file), 'utf8'),
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker failures reject generation instead of publishing successful indexes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'starknet-artifacts-'));
  try {
    await writeFile(join(root, 'contracts_broken.contract_class.json'), '{');
    const generator = new StarknetArtifactGenerator(
      root,
      join(root, 'out/artifacts'),
    );
    await assert.rejects(generator.generate());
    await assert.rejects(readFile(join(root, 'out/artifacts/index.js')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
