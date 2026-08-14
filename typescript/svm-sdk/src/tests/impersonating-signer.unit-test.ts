import {
  AccountRole,
  type Address,
  type TransactionSigner,
  address,
  blockhash,
  generateKeyPairSigner,
  signature as toSignature,
} from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { describe, it } from 'mocha';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

import { SvmImpersonatingSigner } from '../clients/impersonating-signer.js';
import type { SvmRpc, SvmTransaction } from '../types.js';

chai.use(chaiAsPromised);

// System program — a valid, well-known program address to invoke.
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
// The account the signer is configured to impersonate.
const IMPERSONATED_USER = address(
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9nWLyBpb',
);
// A different required signer the signer is NOT configured to impersonate.
const OTHER_SIGNER = address('E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi');

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

async function createTestSigner(
  rpc: SvmRpc,
  userAddress: Address,
): Promise<SvmImpersonatingSigner> {
  const signer = await SvmImpersonatingSigner.create(
    TEST_CHAIN_METADATA,
    userAddress,
  );
  signer['rpc'] = rpc;
  return signer;
}

/**
 * A transaction whose instruction requires each given account as a signer. Any
 * `additionalSigners` are attached to the message so partial signing fills
 * their slots (mirroring a build-time ephemeral keypair such as a
 * transfer_remote message account).
 */
function txRequiringSigners(
  signerAddresses: Address[],
  additionalSigners: TransactionSigner[] = [],
): SvmTransaction {
  return {
    instructions: [
      {
        programAddress: SYSTEM_PROGRAM,
        accounts: signerAddresses.map((signerAddress) => ({
          address: signerAddress,
          role: AccountRole.READONLY_SIGNER,
        })),
        data: new Uint8Array(),
      },
    ],
    additionalSigners,
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
  it('signs a transaction whose only required signer is the impersonated account', async () => {
    const sent: SentTransaction[] = [];
    const signer = await createTestSigner(
      createCapturingRpc(sent),
      IMPERSONATED_USER,
    );

    const receipt = await signer.send(txRequiringSigners([IMPERSONATED_USER]));

    // The returned signature is the fee payer's real signature over the
    // message, proving partial signing produced a submittable transaction.
    expect(receipt.signature).to.be.a('string').with.length.greaterThan(0);
    expect(sent).to.have.length(1);
  });

  it('signs the fee-payer slot and leaves the impersonated account slot empty', async () => {
    const sent: SentTransaction[] = [];
    const signer = await createTestSigner(
      createCapturingRpc(sent),
      IMPERSONATED_USER,
    );

    await signer.send(txRequiringSigners([IMPERSONATED_USER]));

    const slots = decodeSignatureSlots(sent[0].rawTx);
    expect(slots).to.have.length(2);
    // Slot 0 is the fee payer (always first) and must be signed.
    expect(slots[0].some((b) => b !== 0)).to.equal(true);
    // Slot 1 is the impersonated account and must be zero-filled.
    expect(slots[1].every((b) => b === 0)).to.equal(true);
  });

  it('submits with skipPreflight enabled', async () => {
    const sent: SentTransaction[] = [];
    const signer = await createTestSigner(
      createCapturingRpc(sent),
      IMPERSONATED_USER,
    );

    await signer.send(txRequiringSigners([IMPERSONATED_USER]));

    expect(sent[0].skipPreflight).to.equal(true);
  });

  it('allows an additional required signer that is signed at build time', async () => {
    const sent: SentTransaction[] = [];
    const signer = await createTestSigner(
      createCapturingRpc(sent),
      IMPERSONATED_USER,
    );
    const ephemeral = await generateKeyPairSigner();

    const receipt = await signer.send(
      txRequiringSigners([IMPERSONATED_USER, ephemeral.address], [ephemeral]),
    );

    expect(receipt.signature).to.be.a('string').with.length.greaterThan(0);
    expect(sent).to.have.length(1);
    const slots = decodeSignatureSlots(sent[0].rawTx);
    expect(slots).to.have.length(3);
    // Fee payer and the ephemeral signer are filled; only the impersonated
    // account's slot is left empty.
    const signedSlots = slots.filter((slot) => slot.some((b) => b !== 0));
    expect(signedSlots).to.have.length(2);
  });

  it('rejects a transaction leaving a foreign signature unfilled', async () => {
    const sent: SentTransaction[] = [];
    const signer = await createTestSigner(
      createCapturingRpc(sent),
      IMPERSONATED_USER,
    );

    await expect(
      signer.send(txRequiringSigners([OTHER_SIGNER])),
    ).to.be.rejectedWith(
      `Impersonated submitter is configured to impersonate ${IMPERSONATED_USER}, but the transaction leaves a required signature unfilled for ${OTHER_SIGNER}`,
    );
    expect(sent).to.have.length(0);
  });

  it('rejects a foreign unfilled slot alongside the impersonated account', async () => {
    const sent: SentTransaction[] = [];
    const signer = await createTestSigner(
      createCapturingRpc(sent),
      IMPERSONATED_USER,
    );

    await expect(
      signer.send(txRequiringSigners([IMPERSONATED_USER, OTHER_SIGNER])),
    ).to.be.rejectedWith(
      `Impersonated submitter is configured to impersonate ${IMPERSONATED_USER}, but the transaction leaves a required signature unfilled for ${OTHER_SIGNER}`,
    );
    expect(sent).to.have.length(0);
  });
});
