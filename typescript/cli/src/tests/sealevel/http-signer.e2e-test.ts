import { expect } from 'chai';
import {
  type KeyPairSigner,
  createKeyPairSignerFromPrivateKeyBytes,
  createSignableMessage,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit';

import { loadProtocolProviders } from '@hyperlane-xyz/deploy-sdk';
import {
  HttpServer,
  type TransactionSignerBackend,
} from '@hyperlane-xyz/http-registry-server';
import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';
import { SealevelSigner } from '@hyperlane-xyz/sealevel-sdk';
import { ProtocolType, assert, fromHexString } from '@hyperlane-xyz/utils';

import { createAltVMSigners } from '../../context/altvm.js';
import {
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
} from '../constants.js';

const TOKEN = 'cd'.repeat(32);
const CHAIN = TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.name;
const transactionDecoder = getTransactionDecoder();
const transactionEncoder = getTransactionEncoder();

class LocalKitSignerBackend implements TransactionSignerBackend {
  constructor(private readonly signer: KeyPairSigner) {}

  async getAccount() {
    return { address: this.signer.address, curve: 'ed25519' as const };
  }

  async healthCheck(): Promise<void> {}

  async signTransaction(
    protocol: ProtocolType,
    unsignedTransaction: Uint8Array,
  ) {
    assert(protocol === ProtocolType.Sealevel, 'Expected Sealevel transaction');
    const transaction = transactionDecoder.decode(unsignedTransaction);
    const [signature] = await this.signer.signMessages([
      createSignableMessage(Uint8Array.from(transaction.messageBytes)),
    ]);
    return {
      signedTransaction: Uint8Array.from(
        transactionEncoder.encode({
          ...transaction,
          signatures: { ...transaction.signatures, ...signature },
        }),
      ),
    };
  }
}

describe('HTTP signer Sealevel e2e', function () {
  this.timeout(120_000);

  let server: HttpServer | undefined;
  const previousToken = process.env.HYP_HTTP_SIGNER_TOKEN;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (previousToken === undefined) delete process.env.HYP_HTTP_SIGNER_TOKEN;
    else process.env.HYP_HTTP_SIGNER_TOKEN = previousToken;
  });

  it('signs remotely, broadcasts, and confirms on the local validator', async () => {
    process.env.HYP_HTTP_SIGNER_TOKEN = TOKEN;
    const privateKey = fromHexString(HYP_KEY_BY_PROTOCOL.sealevel);
    const localSigner =
      await createKeyPairSignerFromPrivateKeyBytes(privateKey);
    const registry = new FileSystemRegistry({ uri: REGISTRY_PATH });
    server = await HttpServer.create(async () => registry, {
      signerToken: TOKEN,
      signers: {
        [ProtocolType.Sealevel]: new LocalKitSignerBackend(localSigner),
      },
    });
    const listener = await server.start('0');
    const boundAddress = listener.address();
    assert(
      typeof boundAddress === 'object' && boundAddress !== null,
      'Expected signer server TCP address',
    );

    await loadProtocolProviders(new Set([ProtocolType.Sealevel]));
    const signers = await createAltVMSigners(
      {
        getChainMetadata: () =>
          TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      },
      [CHAIN],
      {
        [ProtocolType.Sealevel]: `http://127.0.0.1:${boundAddress.port}#${localSigner.address}`,
      },
      {},
    );
    const signer = signers[CHAIN];
    assert(
      signer instanceof SealevelSigner,
      'Expected a remotely backed Sealevel signer',
    );

    const receipt = await signer.send({ instructions: [] });

    expect(receipt.signature).to.be.a('string').and.not.be.empty;
    expect(receipt.slot).to.be.a('bigint');
  });
});
