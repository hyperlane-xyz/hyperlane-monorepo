import {
  AccountRole,
  address,
  blockhash,
  signature as toSignature,
} from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

import { SvmImpersonatingSigner } from '../clients/impersonating-signer.js';
import type { SvmRpc, SvmTransaction } from '../types.js';

// System program — a valid, well-known program address to invoke.
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
// A required signer whose key the impersonating signer does not hold.
const FOREIGN_SIGNER = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9nWLyBpb');

const FAKE_BLOCKHASH = blockhash(
  '4nQrcFMj3GKNXaVGRmnAPVagSnTeAF2r2RWyskNswDJf',
);
const FAKE_SIGNATURE = toSignature(
  '5wHu1qwD7q5JNMPbHBfUhLmk7GKBX2vRvNcF9jEJvR7p3yfXnBmWdYPQXkbRZJhzGN5LpVR6pRxw7VGnPJb7Qss', // gitleaks:allow
);

const TEST_CHAIN_METADATA: ChainMetadataForAltVM = {
  name: 'solanamainnet',
  protocol: ProtocolType.Sealevel,
  chainId: 1399811149,
  domainId: 1399811149,
  rpcUrls: [{ http: 'http://localhost:8899' }],
};

interface SentTransaction {
  rawTx: string;
  skipPreflight?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function readSkipPreflight(options: unknown): boolean | undefined {
  if (isRecord(options) && typeof options.skipPreflight === 'boolean') {
    return options.skipPreflight;
  }
  return undefined;
}

function createCapturingRpc(sent: SentTransaction[]): SvmRpc {
  const handlers: Record<
    string,
    (...args: unknown[]) => { send: () => Promise<unknown> }
  > = {
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 1000n },
      }),
    }),
    sendTransaction: (rawTx: unknown, options: unknown) => ({
      send: async () => {
        sent.push({
          rawTx: String(rawTx),
          skipPreflight: readSkipPreflight(options),
        });
        return FAKE_SIGNATURE;
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => ({
        value: [
          {
            slot: 42n,
            confirmationStatus: 'confirmed' as const,
            confirmations: 10n,
            err: null,
          },
        ],
      }),
    }),
    getBlockHeight: () => ({ send: async () => 500n }),
  };

  return new Proxy(
    {},
    {
      get(_target, prop) {
        const handler = handlers[String(prop)];
        if (handler) return handler;
        return () => ({
          send: async () => {
            throw new Error(`Unmocked RPC method: ${String(prop)}`);
          },
        });
      },
    },
  ) as unknown as SvmRpc;
}

async function createTestSigner(rpc: SvmRpc): Promise<SvmImpersonatingSigner> {
  const signer = await SvmImpersonatingSigner.connect(TEST_CHAIN_METADATA);
  signer['rpc'] = rpc;
  return signer;
}

/** A transaction whose instruction requires a signer the fee payer does not hold. */
function txRequiringForeignSigner(): SvmTransaction {
  return {
    instructions: [
      {
        programAddress: SYSTEM_PROGRAM,
        accounts: [
          { address: FOREIGN_SIGNER, role: AccountRole.READONLY_SIGNER },
        ],
        data: new Uint8Array(),
      },
    ],
  };
}

/** Decodes the fixed-width 64-byte signature slots from a wire transaction. */
function decodeSignatureSlots(rawTxBase64: string): Uint8Array[] {
  const bytes = new Uint8Array(Buffer.from(rawTxBase64, 'base64'));
  // Signature count is a compact-u16; two required signers fit in one byte.
  const count = bytes[0];
  const slots: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const start = 1 + i * 64;
    slots.push(bytes.slice(start, start + 64));
  }
  return slots;
}

describe('SvmImpersonatingSigner', () => {
  it('partially signs a transaction requiring a foreign signer without throwing', async () => {
    const sent: SentTransaction[] = [];
    const signer = await createTestSigner(createCapturingRpc(sent));

    const receipt = await signer.send(txRequiringForeignSigner());

    // The returned signature is the fee payer's real signature over the
    // message, proving partial signing produced a submittable transaction.
    expect(receipt.signature).to.be.a('string').with.length.greaterThan(0);
    expect(sent).to.have.length(1);
  });

  it('signs the fee-payer slot and leaves the foreign signer slot empty', async () => {
    const sent: SentTransaction[] = [];
    const signer = await createTestSigner(createCapturingRpc(sent));

    await signer.send(txRequiringForeignSigner());

    const slots = decodeSignatureSlots(sent[0].rawTx);
    expect(slots).to.have.length(2);
    // Slot 0 is the fee payer (always first) and must be signed.
    expect(slots[0].some((b) => b !== 0)).to.equal(true);
    // Slot 1 is the impersonated foreign signer and must be zero-filled.
    expect(slots[1].every((b) => b === 0)).to.equal(true);
  });

  it('submits with skipPreflight enabled', async () => {
    const sent: SentTransaction[] = [];
    const signer = await createTestSigner(createCapturingRpc(sent));

    await signer.send(txRequiringForeignSigner());

    expect(sent[0].skipPreflight).to.equal(true);
  });
});
