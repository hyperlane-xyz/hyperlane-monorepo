import {
  isSolanaError,
  SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT,
} from '@solana/errors';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  AccountRole,
  generateKeyPairSigner,
  getBase64Encoder,
  signature,
  lamports,
} from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { assert, pollAsync } from '@hyperlane-xyz/utils';

import { RENT_SYSVAR_ADDRESS } from '../constants.js';
import { SvmSigner } from '../clients/signer.js';
import { createRpc } from '../rpc.js';

// Explicit local test-validator endpoint; never a public-cluster funding test.
describe('v1 transactions on Agave 4.2', function () {
  this.timeout(60000);

  it('sends an oversized v1 transfer batch and reads its receipt and block', async () => {
    const url = process.env.SVM_V1_RPC_URL;
    assert(
      url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname),
      'Set SVM_V1_RPC_URL to a local Agave 4.2+ test validator',
    );
    const rpc = createRpc(url);
    const payer = await generateKeyPairSigner();
    await rpc.requestAirdrop(payer.address, lamports(2_000_000_000n)).send();
    await pollAsync(
      async () => {
        const balance = await rpc
          .getBalance(payer.address, { commitment: 'confirmed' })
          .send();
        assert(balance.value > 0n, 'airdrop pending');
      },
      1000,
      30,
    );
    const signer = await SvmSigner.connectWithSigner(
      {
        name: 'local-v1',
        protocol: ProtocolType.Sealevel,
        chainId: 1,
        domainId: 1,
        rpcUrls: [{ http: url }],
        maxSupportedTransactionVersion: 1,
        sealevelTransactionVersion: 1,
      },
      payer,
    );
    const instructions = Array.from({ length: 60 }, () => {
      const ix = getTransferSolInstruction({
        source: payer,
        destination: payer.address,
        amount: 1n,
      });
      return {
        ...ix,
        accounts: [
          ...ix.accounts,
          { address: RENT_SYSVAR_ADDRESS, role: AccountRole.READONLY },
        ],
      };
    });
    const receipt = await signer.sendAndConfirmTransaction({ instructions });
    expect(
      receipt.meta?.logMessages?.some((log) => log.includes('success')),
    ).to.equal(true);
    assert(receipt.slot !== undefined, 'missing confirmed slot');
    const block = await rpc
      .getBlock(receipt.slot, {
        commitment: 'confirmed',
        encoding: 'json',
        transactionDetails: 'full',
        maxSupportedTransactionVersion: 1,
        rewards: false,
      })
      .send();
    expect(
      block?.transactions.some(
        (tx) =>
          tx.version === 1 &&
          tx.transaction.signatures.includes(signature(receipt.signature)),
      ),
    ).to.equal(true);
    const raw = await rpc
      .getTransaction(signature(receipt.signature), {
        commitment: 'confirmed',
        encoding: 'base64',
        maxSupportedTransactionVersion: 1,
      })
      .send();
    assert(raw, 'missing transaction');
    const wireSize = getBase64Encoder().encode(raw.transaction[0]).length;
    expect(wireSize).to.be.greaterThan(1232).and.at.most(4096);

    // The same instruction batch must still respect v0's smaller packet limit.
    let rejected = false;
    try {
      await signer.send({ instructions, version: 0 });
    } catch (error) {
      rejected = isSolanaError(
        error,
        SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT,
      );
      if (!rejected) throw error;
    }
    expect(rejected).to.equal(true);
    // A normal v0 transfer still works on the same node.
    const v0 = await signer.send({
      instructions: instructions.slice(0, 1),
      version: 0,
    });
    expect(v0.signature).to.be.a('string');
  });
});
