// eslint-disable-next-line import/no-nodejs-modules
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
// eslint-disable-next-line import/no-nodejs-modules
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules
import { tmpdir } from 'node:os';
// eslint-disable-next-line import/no-nodejs-modules
import { join } from 'node:path';
import {
  getCreateAccountInstruction,
  getTransferSolInstruction,
} from '@solana-program/system';
import {
  address,
  generateKeyPairSigner,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  signTransactionMessageWithSigners,
  isSolanaError,
  SOLANA_ERROR__TRANSACTION_ERROR__UNSUPPORTED_VERSION,
  signature,
  lamports,
  type Instruction,
} from '@solana/kit';
import { expect } from 'chai';
import { before, after, describe, it } from 'mocha';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { assert, pollAsync } from '@hyperlane-xyz/utils';
import { SvmSigner } from '../clients/signer.js';
import { createRpc } from '../rpc.js';
import { buildTransactionMessage } from '../tx.js';
import { buildInitMailboxInstruction } from '../core/mailbox-tx.js';
import { fetchMailboxInboxAccount } from '../core/mailbox-query.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';

// Pinned in the CI downloader too. This suite owns local validators and never funds public RPCs.
const AGAVE_VERSION = '4.2.0';
// Agave v4.2.0 feature-set/src/lib.rs: enable_tx_v1.
const V1_FEATURE = 'txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL';
const MAILBOX = address('2Zvzyv2sstAhs9wu1xaLpH5X17dVouEb8zjkBRPKsSy5');
const MEMO = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

for (const enabled of [true, false]) {
  describe(`Agave ${AGAVE_VERSION}, v1 feature ${enabled ? 'on' : 'off'}`, function () {
    this.timeout(120000);
    const url = 'http://127.0.0.1:18899';
    const rpc = createRpc(url);
    let validator: ChildProcess;
    let directory: string;
    let signer: SvmSigner;

    before(async () => {
      const binary =
        process.env.AGAVE_TEST_VALIDATOR ?? 'solana-test-validator';
      expect(
        execFileSync(binary, ['--version'], { encoding: 'utf8' }),
      ).to.match(/\b4\.2\.0\b/);
      directory = mkdtempSync(join(tmpdir(), 'hyperlane-v1-'));
      const program = join(directory, 'mailbox.so');
      writeFileSync(program, HYPERLANE_SVM_PROGRAM_BYTES.mailbox);
      validator = spawn(
        binary,
        [
          '--reset',
          '--ledger',
          join(directory, 'ledger'),
          '--bind-address',
          '127.0.0.1',
          '--rpc-port',
          '18899',
          '--faucet-port',
          '18900',
          '--quiet',
          '--bpf-program',
          MAILBOX,
          program,
          ...(!enabled ? ['--deactivate-feature', V1_FEATURE] : []),
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      );
      await pollAsync(
        async () => {
          assert(validator.exitCode === null, 'test validator exited');
          await rpc.getHealth().send();
        },
        1000,
        60,
      );
      const payer = await generateKeyPairSigner();
      await rpc.requestAirdrop(payer.address, lamports(2_000_000_000n)).send();
      await pollAsync(
        async () => {
          assert(
            (
              await rpc
                .getBalance(payer.address, { commitment: 'confirmed' })
                .send()
            ).value > 0n,
            'airdrop pending',
          );
        },
        1000,
        30,
      );
      signer = await SvmSigner.connectWithSigner(
        {
          name: 'local-v1',
          protocol: ProtocolType.Sealevel,
          chainId: 1,
          domainId: 1,
          rpcUrls: [{ http: url }],
          maxSupportedTransactionVersion: 1,
          sealevelV1TransactionsEnabled: enabled,
          sealevelTransactionVersion: enabled ? 1 : 0,
        },
        payer,
      );
    });

    after(async () => {
      if (validator && validator.exitCode === null) {
        await new Promise<void>((resolve) => {
          validator.once('exit', () => resolve());
          validator.kill('SIGTERM');
        });
      }
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    async function wire(instructions: Instruction[]) {
      const lifetime = (
        await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
      ).value;
      return getBase64EncodedWireTransaction(
        await signTransactionMessageWithSigners(
          buildTransactionMessage({
            version: 1,
            computeUnits: 1_400_000,
            instructions,
            feePayer: signer.signer,
            recentBlockhash: lifetime.blockhash,
            lastValidBlockHeight: lifetime.lastValidBlockHeight,
          }),
        ),
      );
    }

    it('keeps v0 transfers working', async () => {
      const receipt = await signer.sendAndConfirmTransaction({
        version: 0,
        instructions: [
          getTransferSolInstruction({
            source: signer.signer,
            destination: signer.signer.address,
            amount: 1n,
          }),
        ],
      });
      const raw = await rpc
        .getTransaction(signature(receipt.signature), {
          commitment: 'confirmed',
          encoding: 'json',
          maxSupportedTransactionVersion: 1,
        })
        .send();
      expect(raw?.meta?.err).to.equal(null);
    });

    if (!enabled) {
      it('rejects v1 at both the SDK activation gate and the node feature gate', async () => {
        const instructions = [
          getTransferSolInstruction({
            source: signer.signer,
            destination: signer.signer.address,
            amount: 1n,
          }),
        ];
        let sdkError: unknown;
        try {
          await signer.send({ version: 1, instructions });
        } catch (error) {
          sdkError = error;
        }
        expect(String(sdkError)).to.include('sealevelV1TransactionsEnabled');
        let nodeError: unknown;
        try {
          await rpc
            .sendTransaction(await wire(instructions), {
              encoding: 'base64',
              skipPreflight: false,
            })
            .send();
        } catch (error) {
          nodeError = error;
        }
        assert(nodeError instanceof Error, 'missing node error');
        expect(
          isSolanaError(
            nodeError.cause,
            SOLANA_ERROR__TRANSACTION_ERROR__UNSUPPORTED_VERSION,
          ),
        ).to.equal(true);
      });
      return;
    }

    it('executes a Hyperlane mailbox init with two signers and reads v1 receipt/block', async () => {
      const account = await generateKeyPairSigner();
      const rent = await rpc.getMinimumBalanceForRentExemption(0n).send();
      const create = getCreateAccountInstruction({
        payer: signer.signer,
        newAccount: account,
        lamports: rent,
        space: 0n,
        programAddress: SYSTEM_PROGRAM_ADDRESS,
      });
      const init = await buildInitMailboxInstruction(MAILBOX, signer.signer, {
        localDomain: 1234,
        defaultIsm: signer.signer.address,
        maxProtocolFee: 0n,
        protocolFee: { fee: 0n, beneficiary: signer.signer.address },
      });
      const receipt = await signer.sendAndConfirmTransaction({
        instructions: [create, init],
      });
      const raw = await rpc
        .getTransaction(signature(receipt.signature), {
          commitment: 'confirmed',
          encoding: 'json',
          maxSupportedTransactionVersion: 1,
        })
        .send();
      expect(raw?.meta?.err).to.equal(null);
      expect(
        (await fetchMailboxInboxAccount(rpc, MAILBOX))?.localDomain,
      ).to.equal(1234);
      assert(receipt.slot !== undefined, 'missing slot');
      const block = await rpc
        .getBlock(receipt.slot, {
          commitment: 'confirmed',
          encoding: 'json',
          maxSupportedTransactionVersion: 1,
          transactionDetails: 'full',
          rewards: false,
        })
        .send();
      const tx = block?.transactions.find((tx) =>
        tx.transaction.signatures.includes(signature(receipt.signature)),
      );
      expect(tx?.version).to.equal(1);
      expect(tx?.transaction.signatures).to.have.length(2);
    });

    it('accepts exactly 4096 bytes and rejects 4097 bytes', async () => {
      let data = new Uint8Array(3800).fill(97);
      const size = getBase64Encoder().encode(
        await wire([{ programAddress: MEMO, data }]),
      ).length;
      data = new Uint8Array(data.length + 4096 - size).fill(97);
      const instructions = [{ programAddress: MEMO, data }];
      expect(
        getBase64Encoder().encode(await wire(instructions)),
      ).to.have.length(4096);
      const receipt = await signer.sendAndConfirmTransaction({
        instructions,
        computeUnits: 1_400_000,
      });
      const raw = await rpc
        .getTransaction(signature(receipt.signature), {
          commitment: 'confirmed',
          encoding: 'json',
          maxSupportedTransactionVersion: 1,
        })
        .send();
      expect(raw?.meta?.err).to.equal(null);
      const tx = await rpc
        .getTransaction(signature(receipt.signature), {
          commitment: 'confirmed',
          encoding: 'base64',
          maxSupportedTransactionVersion: 1,
        })
        .send();
      assert(tx, 'missing transaction');
      expect(getBase64Encoder().encode(tx.transaction[0])).to.have.length(4096);
      let error: unknown;
      try {
        await signer.send({
          instructions: [
            {
              programAddress: MEMO,
              data: new Uint8Array(data.length + 1).fill(97),
            },
          ],
        });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).to.match(/size|4096|large/i);
      let legacyError: unknown;
      try {
        await signer.send({ instructions, version: 0 });
      } catch (caught) {
        legacyError = caught;
      }
      expect(String(legacyError)).to.match(/size|1232|large/i);
    });
  });
}
