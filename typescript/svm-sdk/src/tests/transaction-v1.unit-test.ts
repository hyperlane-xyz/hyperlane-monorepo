import { blockhash, generateKeyPairSigner } from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { COMPUTE_BUDGET_PROGRAM_ID } from '../constants.js';
import { buildTransactionMessage } from '../tx.js';

async function params() {
  return {
    feePayer: await generateKeyPairSigner(),
    recentBlockhash: blockhash('11111111111111111111111111111111'),
    lastValidBlockHeight: 1n,
    version: 1 as const,
    computeUnits: 200001,
  };
}

function priceInstruction(price: bigint) {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, price, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, data };
}

describe('v1 transaction header', () => {
  it('preserves adapter priority fees with upward rounding and no budget instruction', async () => {
    const message = buildTransactionMessage({
      ...(await params()),
      instructions: [priceInstruction(6n)],
    });
    expect(message.version).to.equal(1);
    if (message.version !== 1) throw new Error('expected v1');
    expect(message.config?.priorityFeeLamports).to.equal(2n);
    expect(message.config?.computeUnitLimit).to.equal(200001);
    expect(message.config?.loadedAccountsDataSizeLimit).to.equal(
      64 * 1024 * 1024,
    );
    expect(message.instructions).to.have.length(0);
  });

  it('rejects duplicate priority fee sources', async () => {
    const common = await params();
    expect(() =>
      buildTransactionMessage({
        ...common,
        instructions: [priceInstruction(1n), priceInstruction(2n)],
      }),
    ).to.throw('Duplicate priority fee');
    expect(() =>
      buildTransactionMessage({
        ...common,
        priorityFeeMicroLamports: 1,
        instructions: [priceInstruction(1n)],
      }),
    ).to.throw('Duplicate priority fee');
  });

  it('rejects unsupported compute-budget instructions instead of dropping them', async () => {
    const common = await params();
    expect(() =>
      buildTransactionMessage({
        ...common,
        instructions: [
          {
            programAddress: COMPUTE_BUDGET_PROGRAM_ID,
            data: new Uint8Array([1]),
          },
        ],
      }),
    ).to.throw('v1 only converts SetComputeUnitPrice');
  });

  it('rejects invalid header budgets', async () => {
    const common = await params();
    for (const computeUnits of [0, 1.5, 1400001]) {
      expect(() =>
        buildTransactionMessage({ ...common, computeUnits, instructions: [] }),
      ).to.throw('computeUnits');
    }
    for (const priorityFeeMicroLamports of [
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        buildTransactionMessage({
          ...common,
          priorityFeeMicroLamports,
          instructions: [],
        }),
      ).to.throw('priorityFeeMicroLamports');
    }
  });
});
