import {
  AccountRole,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { SvmTransactionCodec } from '../../src/signer/svmCodec.js';

chaiUse(chaiAsPromised);

const metadata: ChainMetadata = {
  name: 'solanamainnet',
  displayName: 'Solana',
  protocol: ProtocolType.Sealevel,
  chainId: 1399811149,
  domainId: 1399811149,
  rpcUrls: [{ http: 'http://localhost:8899' }],
};

describe('SvmTransactionCodec', () => {
  it('accepts a valid signature without allowing message mutation', async () => {
    const signer = await generateKeyPairSigner();
    const message = createTransactionMessage({ version: 0 });
    const withFeePayer = setTransactionMessageFeePayerSigner(signer, message);
    const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash('11111111111111111111111111111111'),
        lastValidBlockHeight: 1n,
      },
      withFeePayer,
    );
    const unsigned = compileTransaction(withLifetime);
    const signed = await signTransactionMessageWithSigners(withLifetime);
    const encoder = getTransactionEncoder();
    const unsignedBytes = Uint8Array.from(encoder.encode(unsigned));
    const signedBytes = Uint8Array.from(encoder.encode(signed));
    const codec = new SvmTransactionCodec();
    const account = { address: signer.address, curve: 'ed25519' as const };

    expect(() =>
      codec.validateUnsigned(unsignedBytes, metadata, account),
    ).not.to.throw();
    const audit = await codec.validateSigned(
      unsignedBytes,
      signedBytes,
      metadata,
      account,
    );
    expect(audit.signer).to.equal(signer.address);

    const mutated = signedBytes.slice();
    mutated[mutated.length - 1] ^= 1;
    expect(() =>
      codec.validateSigned(unsignedBytes, mutated, metadata, account),
    ).to.throw('changed Sealevel message bytes');
  });

  it('rejects a configured account that is not a required signer', async () => {
    const feePayer = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const message = createTransactionMessage({ version: 0 });
    const withFeePayer = setTransactionMessageFeePayerSigner(feePayer, message);
    const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash('11111111111111111111111111111111'),
        lastValidBlockHeight: 1n,
      },
      withFeePayer,
    );
    const bytes = Uint8Array.from(
      getTransactionEncoder().encode(compileTransaction(withLifetime)),
    );
    const codec = new SvmTransactionCodec();

    expect(() =>
      codec.validateUnsigned(bytes, metadata, {
        address: other.address,
        curve: 'ed25519',
      }),
    ).to.throw('not a required transaction signer');
  });

  it('rejects invalid instruction indexes before signing', async () => {
    const signer = await generateKeyPairSigner();
    const program = await generateKeyPairSigner();
    const account = await generateKeyPairSigner();
    const withFeePayer = setTransactionMessageFeePayerSigner(
      signer,
      createTransactionMessage({ version: 0 }),
    );
    const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash('11111111111111111111111111111111'),
        lastValidBlockHeight: 1n,
      },
      withFeePayer,
    );
    const withInstruction = appendTransactionMessageInstruction(
      {
        programAddress: program.address,
        accounts: [{ address: account.address, role: AccountRole.READONLY }],
      },
      withLifetime,
    );
    const transactionEncoder = getTransactionEncoder();
    const wireBytes = Uint8Array.from(
      transactionEncoder.encode(compileTransaction(withInstruction)),
    );
    const transaction = getTransactionDecoder().decode(wireBytes);
    const messageDecoder = getCompiledTransactionMessageDecoder();
    const messageEncoder = getCompiledTransactionMessageEncoder();
    const message = messageDecoder.decode(transaction.messageBytes);
    if (!('instructions' in message)) {
      throw new Error('Expected a legacy or v0 transaction message');
    }
    const instruction = message.instructions[0];
    if (!instruction) throw new Error('Expected a compiled instruction');
    const invalidMessages = [
      {
        expectedError: 'Invalid Sealevel program address index',
        message: {
          ...message,
          instructions: [
            {
              ...instruction,
              programAddressIndex: message.staticAccounts.length,
            },
          ],
        },
      },
      {
        expectedError: 'Invalid Sealevel instruction account index',
        message: {
          ...message,
          instructions: [
            {
              ...instruction,
              accountIndices: [message.staticAccounts.length],
            },
          ],
        },
      },
    ];
    const codec = new SvmTransactionCodec();
    const signerAccount = {
      address: signer.address,
      curve: 'ed25519' as const,
    };

    for (const invalid of invalidMessages) {
      const invalidMessageBytes = messageEncoder.encode(invalid.message);
      const bytes = wireBytes.slice();
      bytes.set(
        invalidMessageBytes,
        bytes.length - transaction.messageBytes.length,
      );
      expect(() =>
        codec.validateUnsigned(bytes, metadata, signerAccount),
      ).to.throw(invalid.expectedError);
    }
  });
});
