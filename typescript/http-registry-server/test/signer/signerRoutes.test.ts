import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import type { Server } from 'node:http';
import request from 'supertest';
import {
  AccountRole,
  type KeyPairSigner,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createSignableMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { PartialRegistry } from '@hyperlane-xyz/registry';
import {
  ProtocolType,
  ensure0x,
  fromHexString,
  strip0x,
} from '@hyperlane-xyz/utils';

import { HttpServer } from '../../HttpServer.js';
import {
  SignerBackendError,
  type Eip712Payload,
  type TransactionSignerBackend,
} from '../../index.js';
import { mockChainMetadata } from '../utils/mockData.js';

chaiUse(chaiAsPromised);

const TOKEN = '11'.repeat(32);
const CHAIN = mockChainMetadata.name;

function registry() {
  return new PartialRegistry({
    chainMetadata: { [CHAIN]: mockChainMetadata },
    chainAddresses: {},
    warpRoutes: [],
  });
}

const svmMetadata = {
  ...mockChainMetadata,
  name: 'solanamainnet',
  displayName: 'Solana',
  protocol: ProtocolType.Sealevel,
  chainId: 1399811149,
  domainId: 1399811149,
};

function unsignedTransaction(
  chainId = Number(mockChainMetadata.chainId),
  type: 0 | 1 | 2 = 2,
) {
  const transaction = {
    type,
    chainId,
    nonce: 0,
    gasLimit: 21_000,
    to: '0x0000000000000000000000000000000000000001',
    value: 3,
    data: '0x',
  };
  if (type === 0) {
    return ethers.utils.serializeTransaction({ ...transaction, gasPrice: 1 });
  }
  if (type === 1) {
    return ethers.utils.serializeTransaction({
      ...transaction,
      gasPrice: 1,
      accessList: [],
    });
  }
  return ethers.utils.serializeTransaction({
    ...transaction,
    maxPriorityFeePerGas: 1,
    maxFeePerGas: 2,
    accessList: [],
  });
}

function stripDomainType(payload: Eip712Payload) {
  const { EIP712Domain: _domain, ...types } = payload.types;
  return types;
}

class WalletBackend implements TransactionSignerBackend {
  constructor(
    readonly wallet: ethers.Wallet,
    private readonly mutateTransaction = false,
  ) {}

  async getAccount() {
    return { address: this.wallet.address, curve: 'secp256k1' as const };
  }

  async healthCheck() {}

  async signTransaction(_protocol: ProtocolType, unsignedBytes: Uint8Array) {
    const parsed = ethers.utils.parseTransaction(unsignedBytes);
    const common = {
      type: parsed.type ?? 0,
      chainId: parsed.chainId,
      nonce: parsed.nonce,
      gasLimit: parsed.gasLimit,
      to: parsed.to,
      value: this.mutateTransaction ? parsed.value.add(1) : parsed.value,
      data: parsed.data,
    };
    const transaction =
      common.type === 0
        ? { ...common, gasPrice: parsed.gasPrice }
        : common.type === 1
          ? {
              ...common,
              gasPrice: parsed.gasPrice,
              accessList: parsed.accessList,
            }
          : {
              ...common,
              maxPriorityFeePerGas: parsed.maxPriorityFeePerGas,
              maxFeePerGas: parsed.maxFeePerGas,
              accessList: parsed.accessList,
            };
    const signed = await this.wallet.signTransaction(transaction);
    return {
      signedTransaction: fromHexString(signed),
      backendRequestId: 'mock-request',
    };
  }

  async signTypedData(typedData: Eip712Payload) {
    return {
      signature: await this.wallet._signTypedData(
        typedData.domain,
        stripDomainType(typedData),
        typedData.message,
      ),
    };
  }
}

class KitBackend implements TransactionSignerBackend {
  constructor(
    private readonly signer: KeyPairSigner,
    private readonly mutateMessage = false,
  ) {}

  async getAccount() {
    return { address: this.signer.address, curve: 'ed25519' as const };
  }

  async healthCheck() {}

  async signTransaction(_protocol: ProtocolType, unsignedBytes: Uint8Array) {
    const transaction = getTransactionDecoder().decode(unsignedBytes);
    const [signature] = await this.signer.signMessages([
      createSignableMessage(Uint8Array.from(transaction.messageBytes)),
    ]);
    const signed = {
      ...transaction,
      signatures: { ...transaction.signatures, ...signature },
    };
    const signedBytes = Uint8Array.from(getTransactionEncoder().encode(signed));
    if (this.mutateMessage) signedBytes[signedBytes.length - 1] ^= 1;
    return { signedTransaction: signedBytes };
  }
}

async function startServer(backend?: TransactionSignerBackend) {
  const server = await HttpServer.create(async () => registry(), {
    signerToken: backend ? TOKEN : undefined,
    signers: backend ? { [ProtocolType.Ethereum]: backend } : undefined,
  });
  const listener = await server.start('0');
  return { server, listener };
}

describe('signer routes', () => {
  let server: HttpServer | undefined;
  let listener: Server | undefined;

  afterEach(async () => {
    if (server) await server.stop();
    server = undefined;
    listener = undefined;
  });

  it('rejects weak tokens and non-loopback signer binding', async () => {
    const backend = new WalletBackend(ethers.Wallet.createRandom());
    await expect(
      HttpServer.create(async () => registry(), {
        signerToken: 'abcd',
        signers: { [ProtocolType.Ethereum]: backend },
      }),
    ).to.be.rejectedWith('at least 32 bytes');

    const previousHost = process.env.HOST;
    process.env.HOST = '0.0.0.0';
    try {
      server = await HttpServer.create(async () => registry(), {
        signerToken: TOKEN,
        signers: { [ProtocolType.Ethereum]: backend },
      });
      await expect(server.start('0')).to.be.rejectedWith(
        'requires HOST to be 127.0.0.1 or ::1',
      );
    } finally {
      if (previousHost === undefined) delete process.env.HOST;
      else process.env.HOST = previousHost;
    }
  });

  it('rejects signer mode combined with registry write mode', async () => {
    const backend = new WalletBackend(ethers.Wallet.createRandom());
    await expect(
      HttpServer.create(async () => registry(), {
        writeMode: true,
        signerToken: TOKEN,
        signers: { [ProtocolType.Ethereum]: backend },
      }),
    ).to.be.rejectedWith(
      'Signer mode cannot be combined with registry write mode',
    );
  });

  it('does not mount signer routes without a backend', async () => {
    ({ server, listener } = await startServer());
    const response = await request(listener).get(`/signer/account/${CHAIN}`);
    expect(response.status).to.equal(404);
  });

  it('authenticates account discovery and rejects browser origins', async () => {
    const wallet = ethers.Wallet.createRandom();
    ({ server, listener } = await startServer(new WalletBackend(wallet)));

    const missingToken = await request(listener).get(
      `/signer/account/${CHAIN}`,
    );
    const browser = await request(listener)
      .get(`/signer/account/${CHAIN}`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Origin', 'https://malicious.example');
    const success = await request(listener)
      .get(`/signer/account/${CHAIN}`)
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(missingToken.status).to.equal(401);
    expect(browser.status).to.equal(403);
    expect(success.status).to.equal(200);
    expect(success.body).to.deep.equal({
      chain: CHAIN,
      protocol: ProtocolType.Ethereum,
      address: wallet.address,
      curve: 'secp256k1',
    });

    const unknown = await request(listener)
      .get('/signer/account/not-a-chain')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(unknown.status).to.equal(404);
  });

  it('returns 404 when the chain protocol has no configured backend', async () => {
    const svmSigner = await generateKeyPairSigner();
    server = await HttpServer.create(async () => registry(), {
      signerToken: TOKEN,
      signers: { [ProtocolType.Sealevel]: new KitBackend(svmSigner) },
    });
    listener = await server.start('0');

    const response = await request(listener)
      .get(`/signer/account/${CHAIN}`)
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).to.equal(404);
    expect(response.body.message).to.equal(
      `No signer configured for protocol ${ProtocolType.Ethereum}`,
    );
  });

  it('authenticates before parsing signer request bodies', async () => {
    ({ server, listener } = await startServer(
      new WalletBackend(ethers.Wallet.createRandom()),
    ));
    const unauthenticatedMalformed = await request(listener)
      .post('/signer/transaction')
      .set('Content-Type', 'application/json')
      .send('{');
    const wrongContentType = await request(listener)
      .post('/signer/transaction')
      .set('Authorization', `Bearer ${TOKEN}`)
      .type('text')
      .send('{}');
    const oversized = await request(listener)
      .post('/signer/transaction')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'a'.repeat(210 * 1024) }));

    expect(unauthenticatedMalformed.status).to.equal(401);
    expect(wrongContentType.status).to.equal(400);
    expect(oversized.status).to.equal(413);
    expect(oversized.body).to.deep.equal({
      message: 'Signer request body is too large',
    });
  });

  it('signs and validates EVM transaction types 0, 1, and 2', async () => {
    const wallet = ethers.Wallet.createRandom();
    ({ server, listener } = await startServer(new WalletBackend(wallet)));
    for (const type of [0, 1, 2] as const) {
      const unsigned = unsignedTransaction(undefined, type);
      const response = await request(listener)
        .post('/signer/transaction')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({
          chain: CHAIN,
          transaction: { encoding: 'hex', value: strip0x(unsigned) },
        });

      expect(response.status).to.equal(200);
      expect(response.body.signerAddress).to.equal(wallet.address);
      expect(response.body.backendRequestId).to.equal('mock-request');
      const signed = ethers.utils.parseTransaction(
        ensure0x(response.body.signedTransaction.value),
      );
      expect(signed.from).to.equal(wallet.address);
      expect(signed.value.eq(3)).to.equal(true);
      expect(signed.type ?? 0).to.equal(type);
    }
  });

  it('rejects wrong-chain and backend-mutated transactions', async () => {
    const wallet = ethers.Wallet.createRandom();
    ({ server, listener } = await startServer(new WalletBackend(wallet, true)));
    const wrongChain = await request(listener)
      .post('/signer/transaction')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        chain: CHAIN,
        transaction: {
          encoding: 'hex',
          value: strip0x(unsignedTransaction(42)),
        },
      });
    const mutated = await request(listener)
      .post('/signer/transaction')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        chain: CHAIN,
        transaction: {
          encoding: 'hex',
          value: strip0x(unsignedTransaction()),
        },
      });

    expect(wrongChain.status).to.equal(400);
    expect(mutated.status).to.equal(502);
  });

  it('rejects malformed and unsupported EVM transactions', async () => {
    ({ server, listener } = await startServer(
      new WalletBackend(ethers.Wallet.createRandom()),
    ));

    for (const value of ['deadbeef', '03c0']) {
      const response = await request(listener)
        .post('/signer/transaction')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({
          chain: CHAIN,
          transaction: { encoding: 'hex', value },
        });
      expect(response.status).to.equal(400);
    }
  });

  it('rejects a transaction signed by a different backend account', async () => {
    const advertisedWallet = ethers.Wallet.createRandom();
    const signingBackend = new WalletBackend(ethers.Wallet.createRandom());
    signingBackend.getAccount = async () => ({
      address: advertisedWallet.address,
      curve: 'secp256k1' as const,
    });
    ({ server, listener } = await startServer(signingBackend));

    const response = await request(listener)
      .post('/signer/transaction')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        chain: CHAIN,
        transaction: {
          encoding: 'hex',
          value: strip0x(unsignedTransaction()),
        },
      });

    expect(response.status).to.equal(502);
    expect(response.body.message).to.equal(
      'Signing backend returned an invalid transaction',
    );
  });

  it('validates and signs EIP-712 typed data', async () => {
    const wallet = ethers.Wallet.createRandom();
    ({ server, listener } = await startServer(new WalletBackend(wallet)));
    const response = await request(listener)
      .post('/signer/typed-data')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        chain: CHAIN,
        typedData: {
          types: {
            EIP712Domain: [{ name: 'chainId', type: 'uint256' }],
            Mail: [{ name: 'contents', type: 'string' }],
          },
          primaryType: 'Mail',
          domain: { chainId: String(mockChainMetadata.chainId) },
          message: { contents: 'hello' },
        },
      });

    expect(response.status).to.equal(200);
    expect(response.body.signerAddress).to.equal(wallet.address);
    expect(response.body.signature).to.match(/^0x[0-9a-f]{130}$/);

    const malformedChainId = await request(listener)
      .post('/signer/typed-data')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        chain: CHAIN,
        typedData: {
          types: {
            EIP712Domain: [{ name: 'chainId', type: 'uint256' }],
            Mail: [{ name: 'contents', type: 'string' }],
          },
          primaryType: 'Mail',
          domain: { chainId: 'not-a-number' },
          message: { contents: 'hello' },
        },
      });
    expect(malformedChainId.status).to.equal(400);
  });

  it('maps backend failures without exposing backend messages', async () => {
    const backend = new WalletBackend(ethers.Wallet.createRandom());
    ({ server, listener } = await startServer(backend));
    for (const [kind, status, message] of [
      ['denied', 403, 'Signing request was denied by backend policy'],
      [
        'approvalRequired',
        409,
        'Signing request requires unsupported backend approval',
      ],
      ['unavailable', 502, 'Signing backend is unavailable'],
    ] as const) {
      backend.signTransaction = async () => {
        throw new SignerBackendError(kind, 'sensitive backend details');
      };
      const response = await request(listener)
        .post('/signer/transaction')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({
          chain: CHAIN,
          transaction: {
            encoding: 'hex',
            value: strip0x(unsignedTransaction()),
          },
        });

      expect(response.status).to.equal(status);
      expect(response.body.message).to.equal(message);
      expect(JSON.stringify(response.body)).not.to.contain('sensitive');
    }
  });

  it('signs an SVM v0 transaction and preserves another signature', async () => {
    const remoteSigner = await generateKeyPairSigner();
    const otherSigner = await generateKeyPairSigner();
    server = await HttpServer.create(
      async () =>
        new PartialRegistry({
          chainMetadata: { [svmMetadata.name]: svmMetadata },
          chainAddresses: {},
          warpRoutes: [],
        }),
      {
        signerToken: TOKEN,
        signers: {
          [ProtocolType.Sealevel]: new KitBackend(remoteSigner),
        },
      },
    );
    listener = await server.start('0');

    const message = createTransactionMessage({ version: 0 });
    const withFeePayer = setTransactionMessageFeePayerSigner(
      remoteSigner,
      message,
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
        programAddress: address('11111111111111111111111111111111'),
        accounts: [
          { address: otherSigner.address, role: AccountRole.READONLY_SIGNER },
        ],
      },
      withLifetime,
    );
    const unsigned = compileTransaction(withInstruction);
    const [otherSignature] = await otherSigner.signMessages([
      createSignableMessage(Uint8Array.from(unsigned.messageBytes)),
    ]);
    const partiallySigned = {
      ...unsigned,
      signatures: { ...unsigned.signatures, ...otherSignature },
    };
    const wireBytes = getTransactionEncoder().encode(partiallySigned);

    const response = await request(listener)
      .post('/signer/transaction')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        chain: svmMetadata.name,
        transaction: {
          encoding: 'base64',
          value: Buffer.from(wireBytes).toString('base64'),
        },
      });

    expect(response.status).to.equal(200);
    const returned = getTransactionDecoder().decode(
      Buffer.from(response.body.signedTransaction.value, 'base64'),
    );
    expect(returned.signatures[remoteSigner.address]).not.to.equal(null);
    expect(
      Buffer.from(returned.signatures[otherSigner.address]!).equals(
        otherSignature[otherSigner.address]!,
      ),
    ).to.equal(true);
  });

  it('rejects oversized, mutated, and wrong-signer SVM transactions', async () => {
    const remoteSigner = await generateKeyPairSigner();
    const wrongSigner = await generateKeyPairSigner();
    server = await HttpServer.create(
      async () =>
        new PartialRegistry({
          chainMetadata: { [svmMetadata.name]: svmMetadata },
          chainAddresses: {},
          warpRoutes: [],
        }),
      {
        signerToken: TOKEN,
        signers: {
          [ProtocolType.Sealevel]: new KitBackend(remoteSigner, true),
        },
      },
    );
    listener = await server.start('0');

    const message = createTransactionMessage({ version: 0 });
    const withFeePayer = setTransactionMessageFeePayerSigner(
      remoteSigner,
      message,
    );
    const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash('11111111111111111111111111111111'),
        lastValidBlockHeight: 1n,
      },
      withFeePayer,
    );
    const wireBytes = getTransactionEncoder().encode(
      compileTransaction(withLifetime),
    );
    const mutated = await request(listener)
      .post('/signer/transaction')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        chain: svmMetadata.name,
        transaction: {
          encoding: 'base64',
          value: Buffer.from(wireBytes).toString('base64'),
        },
      });
    const oversized = await request(listener)
      .post('/signer/transaction')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        chain: svmMetadata.name,
        transaction: {
          encoding: 'base64',
          value: Buffer.alloc(1233).toString('base64'),
        },
      });

    expect(mutated.status).to.equal(502);
    expect(oversized.status).to.equal(400);

    await server.stop();
    server = await HttpServer.create(
      async () =>
        new PartialRegistry({
          chainMetadata: { [svmMetadata.name]: svmMetadata },
          chainAddresses: {},
          warpRoutes: [],
        }),
      {
        signerToken: TOKEN,
        signers: {
          [ProtocolType.Sealevel]: new KitBackend(wrongSigner),
        },
      },
    );
    listener = await server.start('0');
    const wrong = await request(listener)
      .post('/signer/transaction')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        chain: svmMetadata.name,
        transaction: {
          encoding: 'base64',
          value: Buffer.from(wireBytes).toString('base64'),
        },
      });
    expect(wrong.status).to.equal(400);
  });
});
