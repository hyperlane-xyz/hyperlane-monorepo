import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SolanaError,
} from '@solana/errors';
import { blockhash, signature as toSignature } from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { afterEach, describe, it } from 'mocha';
import sinon from 'sinon';

chai.use(chaiAsPromised);

import { SvmSigner } from '../clients/signer.js';
import type { SvmRpc, SvmTransaction } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_BLOCKHASH = blockhash(
  '4nQrcFMj3GKNXaVGRmnAPVagSnTeAF2r2RWyskNswDJf',
);
const FAKE_SIGNATURE = toSignature(
  '5wHu1qwD7q5JNMPbHBfUhLmk7GKBX2vRvNcF9jEJvR7p3yfXnBmWdYPQXkbRZJhzGN5LpVR6pRxw7VGnPJb7Qss', // gitleaks:allow
);

function noopTx(): SvmTransaction {
  return { instructions: [] };
}

type RpcMethodStub = (...args: unknown[]) => { send: () => Promise<unknown> };

interface MockRpcConfig {
  getLatestBlockhash?: RpcMethodStub;
  sendTransaction?: RpcMethodStub;
  getSignatureStatuses?: RpcMethodStub;
  getBlockHeight?: RpcMethodStub;
}

function createMockRpc(config: MockRpcConfig = {}): SvmRpc {
  const defaultBlockhash = () => ({
    send: async () => ({
      value: {
        blockhash: FAKE_BLOCKHASH,
        lastValidBlockHeight: 1000n,
      },
    }),
  });

  const defaultSendTx = () => ({
    send: async () => FAKE_SIGNATURE,
  });

  const defaultSignatureStatuses = () => ({
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
  });

  const defaultBlockHeight = () => ({
    send: async () => 500n,
  });

  return new Proxy(
    {},
    {
      get(_target, prop) {
        switch (prop) {
          case 'getLatestBlockhash':
            return config.getLatestBlockhash ?? defaultBlockhash;
          case 'sendTransaction':
            return config.sendTransaction ?? defaultSendTx;
          case 'getSignatureStatuses':
            return config.getSignatureStatuses ?? defaultSignatureStatuses;
          case 'getBlockHeight':
            return config.getBlockHeight ?? defaultBlockHeight;
          default:
            return () => ({
              send: async () => {
                throw new Error(`Unmocked RPC method: ${String(prop)}`);
              },
            });
        }
      },
    },
  ) as unknown as SvmRpc;
}

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

async function createTestSigner(rpc: SvmRpc): Promise<SvmSigner> {
  const signer = await SvmSigner.connectWithSigner(
    ['http://localhost:8899'],
    TEST_PRIVATE_KEY,
  );
  signer['rpc'] = rpc;
  return signer;
}

function makePreflightBlockhashError(): SolanaError {
  const cause = new SolanaError(
    SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  );
  return new SolanaError(
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
    {
      cause,
      accounts: null,
      loadedAccountsDataSize: 0,
      logs: [],
      replacementBlockhash: null,
      returnData: null,
      unitsConsumed: 0n,
      innerInstructions: undefined,
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SvmSigner', () => {
  afterEach(() => sinon.restore());

  // ---- Happy path ----

  describe('send — happy path', () => {
    it('confirms on first poll', async () => {
      const rpc = createMockRpc();
      const signer = await createTestSigner(rpc);
      const receipt = await signer.send(noopTx());

      expect(receipt.slot).to.equal(42n);
      expect(receipt.signature).to.be.a('string').and.not.empty;
    });

    it('accepts finalized status as confirmed', async () => {
      const rpc = createMockRpc({
        getSignatureStatuses: () => ({
          send: async () => ({
            value: [
              {
                slot: 55n,
                confirmationStatus: 'finalized',
                confirmations: null,
                err: null,
              },
            ],
          }),
        }),
      });

      const signer = await createTestSigner(rpc);
      const receipt = await signer.send(noopTx());
      expect(receipt.slot).to.equal(55n);
    });
  });

  // ---- Blockhash not found retry ----

  describe('send — blockhash not found retry', () => {
    it('retries on direct SolanaError blockhash not found', async () => {
      let sendAttempts = 0;
      const rpc = createMockRpc({
        sendTransaction: () => ({
          send: async () => {
            sendAttempts++;
            if (sendAttempts <= 2) {
              throw new SolanaError(
                SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
              );
            }
            return FAKE_SIGNATURE;
          },
        }),
      });

      const signer = await createTestSigner(rpc);
      const receipt = await signer.send(noopTx());

      expect(receipt).to.have.property('signature');
      expect(sendAttempts).to.equal(3);
    });

    it('retries on preflight failure wrapping blockhash not found', async () => {
      let sendAttempts = 0;
      const rpc = createMockRpc({
        sendTransaction: () => ({
          send: async () => {
            sendAttempts++;
            if (sendAttempts <= 1) {
              throw makePreflightBlockhashError();
            }
            return FAKE_SIGNATURE;
          },
        }),
      });

      const signer = await createTestSigner(rpc);
      const receipt = await signer.send(noopTx());

      expect(receipt).to.have.property('signature');
      expect(sendAttempts).to.equal(2);
    });

    it('does not retry on non-blockhash errors', async () => {
      let sendAttempts = 0;
      const rpc = createMockRpc({
        sendTransaction: () => ({
          send: async () => {
            sendAttempts++;
            throw new Error('Insufficient funds');
          },
        }),
      });

      const signer = await createTestSigner(rpc);
      await expect(signer.send(noopTx())).to.be.rejectedWith(
        'Insufficient funds',
      );
      expect(sendAttempts).to.equal(1);
    });

    it('throws after exhausting all signAndSend attempts', async () => {
      let sendAttempts = 0;
      const rpc = createMockRpc({
        sendTransaction: () => ({
          send: async () => {
            sendAttempts++;
            throw new SolanaError(
              SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
            );
          },
        }),
      });

      const signer = await createTestSigner(rpc);
      await expect(signer.send(noopTx())).to.be.rejectedWith(
        /Blockhash not found/,
      );
      // signAndSend maxAttempts = 5
      expect(sendAttempts).to.equal(5);
    });
  });

  // ---- Transaction error propagation ----

  describe('send — transaction error propagation', () => {
    it('throws SvmTransactionError when tx fails on-chain', async () => {
      const rpc = createMockRpc({
        getSignatureStatuses: () => ({
          send: async () => ({
            value: [
              {
                slot: 42n,
                confirmationStatus: 'confirmed',
                confirmations: 10n,
                err: { InstructionError: [0, 'ProgramFailedToComplete'] },
              },
            ],
          }),
        }),
      });

      const signer = await createTestSigner(rpc);
      try {
        await signer.send(noopTx());
        expect.fail('should have thrown');
      } catch (error) {
        expect((error as Error).name).to.equal('SvmTransactionError');
        expect((error as Error).message).to.match(/Transaction failed/);
      }
    });
  });

  // ---- Poll deadline ----

  describe('send — block height failure safety net', () => {
    it('exits polling after consecutive block height check failures', async function () {
      this.timeout(10_000);

      let blockHeightCalls = 0;
      const rpc = createMockRpc({
        // Tx never found
        getSignatureStatuses: () => ({
          send: async () => ({ value: [null] }),
        }),
        // Always fails — triggers the safety net after 3 consecutive failures
        getBlockHeight: () => ({
          send: async () => {
            blockHeightCalls++;
            throw new Error('RPC unavailable');
          },
        }),
      });

      const signer = await createTestSigner(rpc);
      await expect(signer.send(noopTx())).to.be.rejectedWith(
        /Transaction not confirmed after 3 blockhash attempts/,
      );
      // 3 blockhash attempts × 3 failures each = 9
      expect(blockHeightCalls).to.equal(9);
    });
  });

  // ---- Blockhash expiry and resubmit ----

  describe('send — blockhash expiry and resubmit', () => {
    it('resubmits with new blockhash when block height exceeds lastValidBlockHeight', async function () {
      this.timeout(10_000);

      let blockhashFetches = 0;
      let statusCalls = 0;

      const rpc = createMockRpc({
        getLatestBlockhash: () => ({
          send: async () => {
            blockhashFetches++;
            return {
              value: {
                blockhash: FAKE_BLOCKHASH,
                lastValidBlockHeight: 100n,
              },
            };
          },
        }),
        getSignatureStatuses: () => ({
          send: async () => {
            statusCalls++;
            // Confirm on the second blockhash attempt
            if (blockhashFetches >= 2 && statusCalls > 3) {
              return {
                value: [
                  {
                    slot: 99n,
                    confirmationStatus: 'confirmed',
                    confirmations: 10n,
                    err: null,
                  },
                ],
              };
            }
            return { value: [null] };
          },
        }),
        getBlockHeight: () => ({
          send: async () => 200n,
        }),
      });

      const signer = await createTestSigner(rpc);
      const receipt = await signer.send(noopTx());

      expect(receipt.slot).to.equal(99n);
      expect(blockhashFetches).to.equal(2);
    });

    it('exhausts all 3 blockhash attempts and throws', async function () {
      this.timeout(10_000);

      let blockhashFetches = 0;
      const rpc = createMockRpc({
        getLatestBlockhash: () => ({
          send: async () => {
            blockhashFetches++;
            return {
              value: {
                blockhash: FAKE_BLOCKHASH,
                lastValidBlockHeight: 0n,
              },
            };
          },
        }),
        // Tx never found
        getSignatureStatuses: () => ({
          send: async () => ({ value: [null] }),
        }),
        // Always expired
        getBlockHeight: () => ({
          send: async () => 9999n,
        }),
      });

      const signer = await createTestSigner(rpc);
      await expect(signer.send(noopTx())).to.be.rejectedWith(
        /Transaction not confirmed after 3 blockhash attempts/,
      );
      // 3 outer attempts * signAndSend fetches
      expect(blockhashFetches).to.equal(3);
    });
  });

  // ---- History check ----

  describe('send — history check finds confirmed tx', () => {
    it('returns receipt from history check after blockhash expiry', async function () {
      this.timeout(10_000);

      let historyCalled = false;

      const rpc = createMockRpc({
        getSignatureStatuses: (...args: unknown[]) => ({
          send: async () => {
            const opts = args[1] as
              | { searchTransactionHistory?: boolean }
              | undefined;
            if (opts?.searchTransactionHistory) {
              historyCalled = true;
              return {
                value: [
                  {
                    slot: 77n,
                    confirmationStatus: 'confirmed',
                    confirmations: 10n,
                    err: null,
                  },
                ],
              };
            }
            return { value: [null] };
          },
        }),
        getBlockHeight: () => ({
          send: async () => 9999n,
        }),
      });

      const signer = await createTestSigner(rpc);
      const receipt = await signer.send(noopTx());

      expect(historyCalled).to.be.true;
      expect(receipt.slot).to.equal(77n);
    });
  });

  // ---- History check — processed status re-polling ----

  describe('send — history check with processed status', () => {
    it('re-polls with fresh blockhash when history finds tx at processed', async function () {
      this.timeout(10_000);

      let blockhashFetches = 0;
      let pollPhase: 'initial' | 'retry' = 'initial';

      const rpc = createMockRpc({
        getLatestBlockhash: () => ({
          send: async () => {
            blockhashFetches++;
            return {
              value: {
                blockhash: FAKE_BLOCKHASH,
                // Fresh blockhash on retry gives new valid height
                lastValidBlockHeight: blockhashFetches === 1 ? 100n : 2000n,
              },
            };
          },
        }),
        getSignatureStatuses: (...args: unknown[]) => ({
          send: async () => {
            const opts = args[1] as
              | { searchTransactionHistory?: boolean }
              | undefined;
            if (opts?.searchTransactionHistory) {
              // History check: tx is at processed
              pollPhase = 'retry';
              return {
                value: [
                  {
                    slot: 88n,
                    confirmationStatus: 'processed',
                    confirmations: 0n,
                    err: null,
                  },
                ],
              };
            }
            if (pollPhase === 'retry') {
              // During retry poll: tx now confirmed
              return {
                value: [
                  {
                    slot: 88n,
                    confirmationStatus: 'confirmed',
                    confirmations: 10n,
                    err: null,
                  },
                ],
              };
            }
            // Initial poll: not found
            return { value: [null] };
          },
        }),
        getBlockHeight: () => ({
          send: async () => 200n,
        }),
      });

      const signer = await createTestSigner(rpc);
      const receipt = await signer.send(noopTx());

      expect(receipt.slot).to.equal(88n);
      // 1 for signAndSend + 1 for fresh blockhash in processed retry
      expect(blockhashFetches).to.equal(2);
    });

    it('throws if processed tx never confirms after retry poll', async function () {
      this.timeout(10_000);

      let blockhashFetches = 0;

      const rpc = createMockRpc({
        getLatestBlockhash: () => ({
          send: async () => {
            blockhashFetches++;
            return {
              value: {
                blockhash: FAKE_BLOCKHASH,
                lastValidBlockHeight: 100n,
              },
            };
          },
        }),
        getSignatureStatuses: (...args: unknown[]) => ({
          send: async () => {
            const opts = args[1] as
              | { searchTransactionHistory?: boolean }
              | undefined;
            if (opts?.searchTransactionHistory) {
              // History: always processed, never confirms
              return {
                value: [
                  {
                    slot: 88n,
                    confirmationStatus: 'processed',
                    confirmations: 0n,
                    err: null,
                  },
                ],
              };
            }
            return { value: [null] };
          },
        }),
        // Always expired
        getBlockHeight: () => ({
          send: async () => 200n,
        }),
      });

      const signer = await createTestSigner(rpc);
      await expect(signer.send(noopTx())).to.be.rejectedWith(
        /was observed at 'processed' but never confirmed/,
      );
      // 1 signAndSend + 1 fresh blockhash for processed retry = 2
      expect(blockhashFetches).to.equal(2);
    });
  });

  // ---- RPC failures during polling ----

  describe('send — RPC failures during polling', () => {
    it('tolerates getSignatureStatuses failures and keeps polling', async function () {
      this.timeout(10_000);

      let statusCalls = 0;
      const rpc = createMockRpc({
        getSignatureStatuses: () => ({
          send: async () => {
            statusCalls++;
            if (statusCalls <= 2) {
              throw new Error('RPC unavailable');
            }
            return {
              value: [
                {
                  slot: 42n,
                  confirmationStatus: 'confirmed',
                  confirmations: 10n,
                  err: null,
                },
              ],
            };
          },
        }),
      });

      const signer = await createTestSigner(rpc);
      const receipt = await signer.send(noopTx());

      expect(receipt.slot).to.equal(42n);
      expect(statusCalls).to.equal(3);
    });

    it('tolerates getBlockHeight failures and keeps polling', async function () {
      this.timeout(10_000);

      let statusCalls = 0;
      let blockHeightCalls = 0;
      const rpc = createMockRpc({
        getSignatureStatuses: () => ({
          send: async () => {
            statusCalls++;
            // Confirm on 3rd call
            if (statusCalls >= 3) {
              return {
                value: [
                  {
                    slot: 42n,
                    confirmationStatus: 'confirmed',
                    confirmations: 10n,
                    err: null,
                  },
                ],
              };
            }
            return { value: [null] };
          },
        }),
        getBlockHeight: () => ({
          send: async () => {
            blockHeightCalls++;
            throw new Error('Block height RPC down');
          },
        }),
      });

      const signer = await createTestSigner(rpc);
      const receipt = await signer.send(noopTx());

      expect(receipt.slot).to.equal(42n);
      // 2 polls with null status hit getBlockHeight before 3rd poll confirms
      expect(blockHeightCalls).to.equal(2);
    });

    it('throws instead of resubmitting when history check hits transient RPC error', async function () {
      this.timeout(10_000);

      let sendTxCalls = 0;

      const rpc = createMockRpc({
        sendTransaction: () => ({
          send: async () => {
            sendTxCalls++;
            return FAKE_SIGNATURE;
          },
        }),
        getSignatureStatuses: (...args: unknown[]) => ({
          send: async () => {
            const opts = args[1] as
              | { searchTransactionHistory?: boolean }
              | undefined;
            if (opts?.searchTransactionHistory) {
              throw new Error('503 Service Unavailable');
            }
            // Regular polls: not found
            return { value: [null] };
          },
        }),
        // Always expired so pollForConfirmation returns null
        getBlockHeight: () => ({
          send: async () => 9999n,
        }),
      });

      const signer = await createTestSigner(rpc);
      await expect(signer.send(noopTx())).to.be.rejectedWith(
        /Cannot safely resubmit: history lookup failed/,
      );
      // Only one send — no resubmit after RPC error
      expect(sendTxCalls).to.equal(1);
    });
  });

  // ---- Rebroadcast ----

  describe('send — rebroadcast during polling', () => {
    it('rebroadcasts when tx is not found and blockhash is valid', async function () {
      this.timeout(10_000);

      let sendTxCalls = 0;
      let statusCalls = 0;
      const rpc = createMockRpc({
        sendTransaction: () => ({
          send: async () => {
            sendTxCalls++;
            return FAKE_SIGNATURE;
          },
        }),
        getSignatureStatuses: () => ({
          send: async () => {
            statusCalls++;
            // Confirm on 3rd poll
            if (statusCalls >= 3) {
              return {
                value: [
                  {
                    slot: 42n,
                    confirmationStatus: 'confirmed',
                    confirmations: 10n,
                    err: null,
                  },
                ],
              };
            }
            return { value: [null] };
          },
        }),
      });

      const signer = await createTestSigner(rpc);
      const receipt = await signer.send(noopTx());

      expect(receipt.slot).to.equal(42n);
      // 1 initial send + 2 rebroadcasts (polls 1 & 2 return null, poll 3 confirms)
      expect(sendTxCalls).to.equal(3);
    });

    it('does not rebroadcast when tx is at processed status', async function () {
      this.timeout(10_000);

      let sendTxCalls = 0;
      let statusCalls = 0;
      const rpc = createMockRpc({
        sendTransaction: () => ({
          send: async () => {
            sendTxCalls++;
            return FAKE_SIGNATURE;
          },
        }),
        getSignatureStatuses: () => ({
          send: async () => {
            statusCalls++;
            if (statusCalls >= 3) {
              return {
                value: [
                  {
                    slot: 42n,
                    confirmationStatus: 'confirmed',
                    confirmations: 10n,
                    err: null,
                  },
                ],
              };
            }
            // Processed — should skip rebroadcast
            return {
              value: [
                {
                  slot: 42n,
                  confirmationStatus: 'processed',
                  confirmations: 0n,
                  err: null,
                },
              ],
            };
          },
        }),
      });

      const signer = await createTestSigner(rpc);
      const receipt = await signer.send(noopTx());

      expect(receipt.slot).to.equal(42n);
      // Only the initial send, no rebroadcasts (processed triggers continue)
      expect(sendTxCalls).to.equal(1);
    });
  });
});
