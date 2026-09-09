import {
  AccountRole,
  address,
  blockhash,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { SvmSigner } from '../clients/signer.js';
import { buildClaimProtocolFeesInstruction } from '../core/mailbox-tx.js';
import { deriveMailboxOutboxPda } from '../pda.js';
import { buildTransactionMessage } from '../tx.js';

const MAILBOX = address('11111111111111111111111111111112');
const BENEFICIARY = address('11111111111111111111111111111113');

describe('mailbox claim', () => {
  for (const version of [0, 1] as const) {
    it(`compiles and signs a permissionless claim through the v${version} signer`, async () => {
      const payer = await generateKeyPairSigner();
      const signer = await SvmSigner.connectWithSigner(
        {
          name: 'solanamainnet',
          protocol: ProtocolType.Sealevel,
          chainId: 1399811149,
          domainId: 1399811149,
          rpcUrls: [{ http: 'http://localhost:8899' }],
        },
        payer,
      );
      const claim = await buildClaimProtocolFeesInstruction(
        MAILBOX,
        BENEFICIARY,
      );
      const { address: outbox } = await deriveMailboxOutboxPda(MAILBOX);
      expect(claim.accounts).to.deep.equal([
        { address: outbox, role: AccountRole.WRITABLE },
        { address: BENEFICIARY, role: AccountRole.WRITABLE },
      ]);
      expect(Array.from(claim.data ?? [])).to.deep.equal([10]);
      const signed = await signer['signMessage'](
        buildTransactionMessage({
          instructions: [claim],
          version,
          feePayer: payer,
          recentBlockhash: blockhash('11111111111111111111111111111111'),
          lastValidBlockHeight: 100n,
          computeUnits: 200_000,
        }),
      );
      const decoded = decompileTransactionMessage(
        getCompiledTransactionMessageDecoder().decode(signed.messageBytes),
      );
      expect(decoded.version).to.equal(version);
      const decodedClaim = decoded.instructions.find(
        (instruction) => instruction.programAddress === MAILBOX,
      );
      expect(decodedClaim?.accounts).to.deep.equal(claim.accounts);
      expect(Array.from(decodedClaim?.data ?? [])).to.deep.equal([10]);
      // Only the fee payer signs; the configured beneficiary is not a signer.
      expect(Object.keys(signed.signatures)).to.deep.equal([payer.address]);
      expect(signed.signatures[payer.address]).not.to.equal(null);
    });
  }
});
