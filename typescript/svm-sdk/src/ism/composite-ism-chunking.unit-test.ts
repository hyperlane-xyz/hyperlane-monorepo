import {
  address as parseAddress,
  generateKeyPairSigner,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import { expect } from 'chai';

import { getSetCompositeIsmDomainInstruction } from '../instructions/composite-ism.js';

import {
  SOLANA_MAX_TRANSACTION_SIZE,
  chunkInstructionsBySize,
  estimateTransactionWireSize,
} from './composite-ism.js';

const PROGRAM_ADDRESS: Address = parseAddress(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

function manyValidators(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'),
  );
}

describe('chunkInstructionsBySize', () => {
  let owner: TransactionSigner;

  before(async () => {
    owner = await generateKeyPairSigner();
  });

  it('keeps every produced chunk within the Solana transaction size limit', async () => {
    // 8 domains, each with a moderately large multisig — enough that a
    // fixed instructions-per-tx count would exceed the limit, but small
    // enough that several fit in each real chunk.
    const items = await Promise.all(
      Array.from({ length: 8 }, (_, domain) =>
        getSetCompositeIsmDomainInstruction(PROGRAM_ADDRESS, owner, domain, {
          kind: 'multisigMessageId',
          validators: manyValidators(10).map((v) =>
            Uint8Array.from(Buffer.from(v.slice(2), 'hex')),
          ),
          threshold: 5,
        }),
      ),
    );

    const chunks = chunkInstructionsBySize(items, (ix) => ix, owner.address);

    expect(chunks.length).to.be.greaterThan(1);
    for (const chunk of chunks) {
      const size = estimateTransactionWireSize(owner.address, chunk);
      expect(size).to.be.at.most(SOLANA_MAX_TRANSACTION_SIZE);
    }
    // Every input item must appear in exactly one output chunk.
    expect(chunks.flat().length).to.equal(items.length);
  });

  it('throws a clear error when a single item alone exceeds the size limit', async () => {
    const hugeInstruction = await getSetCompositeIsmDomainInstruction(
      PROGRAM_ADDRESS,
      owner,
      0,
      {
        kind: 'multisigMessageId',
        // 60 validators alone is already far past the 1232-byte limit for
        // one instruction.
        validators: manyValidators(60).map((v) =>
          Uint8Array.from(Buffer.from(v.slice(2), 'hex')),
        ),
        threshold: 30,
      },
    );

    expect(() =>
      chunkInstructionsBySize(
        [hugeInstruction],
        (ix: Instruction) => ix,
        owner.address,
      ),
    ).to.throw(/exceeds Solana's/);
  });
});
