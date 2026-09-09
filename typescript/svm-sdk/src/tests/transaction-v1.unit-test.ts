import {
  address,
  blockhash,
  generateKeyPairSigner,
  compileTransaction,
  getTransactionEncoder,
  assertIsTransactionWithinSizeLimit,
} from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { COMPUTE_BUDGET_PROGRAM_ID } from '../constants.js';
import { convertLegacySolanaTransaction } from '../legacy-compat.js';
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

function limitInstruction(units: number) {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
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

  it('migrates an embedded compute limit and uses it for priority fee rounding', async () => {
    const message = buildTransactionMessage({
      ...(await params()),
      computeUnits: undefined,
      instructions: [limitInstruction(200001), priceInstruction(6n)],
    });
    if (message.version !== 1) throw new Error('expected v1');
    expect(message.config?.computeUnitLimit).to.equal(200001);
    expect(message.config?.priorityFeeLamports).to.equal(2n);
    expect(message.instructions).to.have.length(0);
  });

  it('accepts an identical explicit limit and rejects conflicting or duplicate limits', async () => {
    const common = await params();
    const message = buildTransactionMessage({
      ...common,
      instructions: [limitInstruction(common.computeUnits)],
    });
    if (message.version !== 1) throw new Error('expected v1');
    expect(message.config?.computeUnitLimit).to.equal(common.computeUnits);
    expect(message.instructions).to.have.length(0);
    expect(() =>
      buildTransactionMessage({
        ...common,
        instructions: [limitInstruction(300000)],
      }),
    ).to.throw('Conflicting compute unit');
    expect(() =>
      buildTransactionMessage({
        ...common,
        computeUnits: undefined,
        instructions: [limitInstruction(200001), limitInstruction(200001)],
      }),
    ).to.throw('Duplicate compute unit');
  });

  it('validates migrated limits and rejects malformed limit instructions', async () => {
    const common = { ...(await params()), computeUnits: undefined };
    for (const units of [0, 1400001, 0xffffffff]) {
      expect(() =>
        buildTransactionMessage({
          ...common,
          instructions: [limitInstruction(units)],
        }),
      ).to.throw('computeUnits');
    }
    for (const length of [1, 4, 6, 9]) {
      const data = new Uint8Array(length);
      data[0] = 2;
      expect(() =>
        buildTransactionMessage({
          ...common,
          instructions: [{ programAddress: COMPUTE_BUDGET_PROGRAM_ID, data }],
        }),
      ).to.throw('Unsupported v1 compute-budget instruction');
    }
  });

  it('migrates legacy heap and loaded-data budgets for both versions', async () => {
    const budget = (discriminator: number, value: number) => {
      const data = new Uint8Array(5);
      data[0] = discriminator;
      new DataView(data.buffer).setUint32(1, value, true);
      return {
        programId: { toBase58: () => COMPUTE_BUDGET_PROGRAM_ID },
        keys: [],
        data,
      };
    };
    const converted = await convertLegacySolanaTransaction({
      instructions: [budget(1, 256 * 1024), budget(4, 128 * 1024)],
    });
    expect(converted.instructions).to.have.length(0);
    expect(converted.heapSize).to.equal(256 * 1024);
    expect(converted.loadedAccountsDataSizeLimit).to.equal(128 * 1024);
    const common = await params();
    const v1 = buildTransactionMessage({
      ...converted,
      ...common,
      addressLookupTables: undefined,
    });
    if (v1.version !== 1) throw new Error('expected v1');
    expect(v1.config?.heapSize).to.equal(256 * 1024);
    expect(v1.config?.loadedAccountsDataSizeLimit).to.equal(128 * 1024);
    expect(v1.instructions).to.have.length(0);
    const v0 = buildTransactionMessage({
      ...converted,
      ...common,
      addressLookupTables: undefined,
      version: 0,
    });
    expect(v0.instructions.map((ix) => ix.data?.[0])).to.deep.equal([2, 1, 4]);
  });

  it('omits a zero priority fee so an exact 4096-byte transaction fits', async () => {
    const common = await params();
    const encode = (dataSize: number, price?: number) =>
      compileTransaction(
        buildTransactionMessage({
          ...common,
          priorityFeeMicroLamports: price,
          instructions: [
            {
              programAddress: address('11111111111111111111111111111111'),
              data: new Uint8Array(dataSize),
            },
          ],
        }),
      );
    const encoder = getTransactionEncoder();
    const overhead = encoder.encode(encode(1000)).length - 1000;
    const atLimit = encode(4096 - overhead);
    expect(encoder.encode(atLimit)).to.have.length(4096);
    expect(() => assertIsTransactionWithinSizeLimit(atLimit)).not.to.throw();
    expect(encoder.encode(encode(4096 - overhead, 0))).to.have.length(4096);
    expect(() =>
      assertIsTransactionWithinSizeLimit(encode(4096 - overhead, 1)),
    ).to.throw();
    expect(() =>
      assertIsTransactionWithinSizeLimit(encode(4097 - overhead)),
    ).to.throw();
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
    ).to.throw('Unsupported v1 compute-budget instruction');
  });

  it('rejects invalid header budgets', async () => {
    const common = await params();
    for (const computeUnits of [0, 1.5, 1400001]) {
      expect(() =>
        buildTransactionMessage({ ...common, computeUnits, instructions: [] }),
      ).to.throw('computeUnits');
    }
    for (const heapSize of [0, 1024, 32769, 263168]) {
      expect(() =>
        buildTransactionMessage({ ...common, heapSize, instructions: [] }),
      ).to.throw('heapSize');
    }
    for (const loadedAccountsDataSizeLimit of [
      0,
      -1,
      1.5,
      64 * 1024 * 1024 + 1,
    ]) {
      expect(() =>
        buildTransactionMessage({
          ...common,
          loadedAccountsDataSizeLimit,
          instructions: [],
        }),
      ).to.throw('loadedAccountsDataSizeLimit');
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
