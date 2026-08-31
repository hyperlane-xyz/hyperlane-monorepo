import { expect } from 'chai';
import { ethers, Wallet } from 'ethers';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import { ChainTechnicalStack, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { SignerTransactionRequestSchema } from '@hyperlane-xyz/http-registry-server';
import { ProtocolType, assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

import { HttpRemoteEvmSigner } from './HttpRemoteEvmSigner.js';
import { HttpSignerClient } from './HttpSignerClient.js';
import { MultiProtocolSignerFactory } from './MultiProtocolSignerFactory.js';

const TOKEN = 'ab'.repeat(32);
const CHAIN = 'testchain';
const CHAIN_ID = 31337;

function transactionFromParsed(
  parsed: ReturnType<typeof ethers.utils.parseTransaction>,
): ethers.providers.TransactionRequest {
  const base = {
    chainId: parsed.chainId,
    nonce: parsed.nonce,
    gasLimit: parsed.gasLimit,
    to: parsed.to ?? undefined,
    value: parsed.value,
    data: parsed.data,
  };
  if (parsed.type === 2) {
    return {
      ...base,
      type: 2,
      maxFeePerGas: parsed.maxFeePerGas,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas,
      accessList: parsed.accessList,
    };
  }
  if (parsed.type === 1) {
    return {
      ...base,
      type: 1,
      gasPrice: parsed.gasPrice,
      accessList: parsed.accessList,
    };
  }
  return { ...base, gasPrice: parsed.gasPrice };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

async function getError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('Expected promise to reject');
}

describe('HttpRemoteEvmSigner', () => {
  const wallet = Wallet.createRandom();
  const wrongWallet = Wallet.createRandom();
  let server: Server | undefined;
  let serverUrl: URL;
  let accountRequests: number;
  let accountDelayMs: number;
  let wrongSignerResponse: boolean;
  let wrongTransactionSigner: boolean;
  let mutateTransactionResponse: boolean;
  let signingRequests: number;

  beforeEach(async () => {
    accountRequests = 0;
    accountDelayMs = 0;
    wrongSignerResponse = false;
    wrongTransactionSigner = false;
    mutateTransactionResponse = false;
    signingRequests = 0;
    const testServer = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.statusCode = 401;
        response.end(JSON.stringify({ message: 'Unauthorized' }));
        return;
      }
      if (request.url === `/signer/account/${CHAIN}`) {
        accountRequests += 1;
        if (accountDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, accountDelayMs));
        }
        response.end(
          JSON.stringify({
            chain: CHAIN,
            protocol: ProtocolType.Ethereum,
            address: wrongWallet.address,
            curve: 'secp256k1',
          }),
        );
        return;
      }
      if (request.url === '/signer/transaction') {
        signingRequests += 1;
        const body = SignerTransactionRequestSchema.parse(
          JSON.parse(await readBody(request)),
        );
        expect(body.chain).to.equal(CHAIN);
        expect(body.transaction.encoding).to.equal('hex');
        const parsed = ethers.utils.parseTransaction(
          ensure0x(body.transaction.value),
        );
        const transaction = transactionFromParsed(parsed);
        const signed = await (
          wrongTransactionSigner ? wrongWallet : wallet
        ).signTransaction(
          mutateTransactionResponse
            ? { ...transaction, value: parsed.value.add(1) }
            : transaction,
        );
        response.end(
          JSON.stringify({
            chain: CHAIN,
            signerAddress: wrongSignerResponse
              ? wrongWallet.address
              : wallet.address,
            signedTransaction: {
              encoding: 'hex',
              value: strip0x(signed),
            },
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: 'Not found' }));
    });
    server = testServer;
    await new Promise<void>((resolve) =>
      testServer.listen(0, '127.0.0.1', resolve),
    );
    const address = testServer.address();
    assert(
      typeof address === 'object' && address !== null,
      'Expected HTTP test server address',
    );
    serverUrl = new URL(`http://127.0.0.1:${address.port}`);
  });

  afterEach(async () => {
    const activeServer = server;
    server = undefined;
    if (!activeServer) return;
    activeServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      activeServer.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('uses the pinned identity without trusting account discovery', async () => {
    const client = new HttpSignerClient(serverUrl, TOKEN);
    const signer = await HttpRemoteEvmSigner.create(
      client,
      CHAIN,
      wallet.address,
    );
    const provider = new ethers.providers.JsonRpcProvider();
    const connected = signer.connect(provider);

    expect(accountRequests).to.equal(0);
    expect(await connected.getAddress()).to.equal(wallet.address);
    expect(connected.provider).to.equal(provider);
  });

  for (const transaction of [
    {
      type: 0,
      chainId: CHAIN_ID,
      nonce: 1,
      gasLimit: 21_000,
      gasPrice: 2,
      to: Wallet.createRandom().address,
      value: 3,
      data: '0x',
    },
    {
      type: 1,
      chainId: CHAIN_ID,
      nonce: 2,
      gasLimit: 25_000,
      gasPrice: 4,
      to: Wallet.createRandom().address,
      value: 5,
      data: '0x1234',
      accessList: [],
    },
    {
      type: 2,
      chainId: CHAIN_ID,
      nonce: 3,
      gasLimit: 30_000,
      maxFeePerGas: 7,
      maxPriorityFeePerGas: 6,
      to: Wallet.createRandom().address,
      value: 8,
      data: '0xabcd',
      accessList: [],
    },
  ]) {
    it(`matches local Wallet output for type ${transaction.type}`, async () => {
      const signer = await HttpRemoteEvmSigner.create(
        new HttpSignerClient(serverUrl, TOKEN),
        CHAIN,
        wallet.address,
      );
      expect(await signer.signTransaction(transaction)).to.equal(
        await wallet.signTransaction(transaction),
      );
    });
  }

  for (const [name, transaction, expectedMessage] of [
    [
      'EIP-1559 fields on a legacy transaction',
      { type: 0, maxFeePerGas: 1 },
      'Legacy Ethereum transactions do not support',
    ],
    [
      'EIP-1559 fields on an EIP-2930 transaction',
      { type: 1, maxPriorityFeePerGas: 1 },
      'EIP-2930 Ethereum transactions do not support',
    ],
    [
      'gasPrice on an EIP-1559 transaction',
      { type: 2, gasPrice: 1 },
      'EIP-1559 Ethereum transactions do not support gasPrice',
    ],
    [
      'unknown populated fields',
      { type: 0, unsupportedField: 1 },
      'does not support Ethereum transaction fields: unsupportedField',
    ],
  ] as const) {
    it(`rejects ${name} before contacting the signer`, async () => {
      const signer = await HttpRemoteEvmSigner.create(
        new HttpSignerClient(serverUrl, TOKEN),
        CHAIN,
        wallet.address,
      );
      const error = await getError(
        signer.signTransaction({
          chainId: CHAIN_ID,
          nonce: 0,
          gasLimit: 21_000,
          to: wallet.address,
          value: 1,
          ...transaction,
        }),
      );

      expect(error.message).to.include(expectedMessage);
      expect(signingRequests).to.equal(0);
    });
  }

  it('fails on timeout and unreachable server', async () => {
    accountDelayMs = 50;
    const timeoutError = await getError(
      new HttpSignerClient(serverUrl, TOKEN, 5).getAccount(CHAIN),
    );
    expect(timeoutError.message).to.include('account discovery failed');

    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
    const unreachableError = await getError(
      new HttpSignerClient(serverUrl, TOKEN, 50).getAccount(CHAIN),
    );
    expect(unreachableError.message).to.include('account discovery failed');
  });

  it('rejects a self-consistent response from an unpinned signer', async () => {
    wrongSignerResponse = true;
    wrongTransactionSigner = true;
    const signer = await HttpRemoteEvmSigner.create(
      new HttpSignerClient(serverUrl, TOKEN),
      CHAIN,
      wallet.address,
    );
    const signerError = await getError(
      signer.signTransaction({
        chainId: CHAIN_ID,
        nonce: 0,
        gasLimit: 21_000,
        gasPrice: 1,
        to: wrongWallet.address,
        value: 1,
      }),
    );
    expect(signerError.message).to.include(
      `returned transaction for ${wrongWallet.address}`,
    );
  });

  it('rejects a transaction signed by the wrong account', async () => {
    wrongTransactionSigner = true;
    const signer = await HttpRemoteEvmSigner.create(
      new HttpSignerClient(serverUrl, TOKEN),
      CHAIN,
      wallet.address,
    );
    const signerError = await getError(
      signer.signTransaction({
        chainId: CHAIN_ID,
        nonce: 0,
        gasLimit: 21_000,
        gasPrice: 1,
        to: wallet.address,
        value: 1,
      }),
    );
    expect(signerError.message).to.include(`signed by ${wrongWallet.address}`);
  });

  it('rejects a modified transaction payload', async () => {
    mutateTransactionResponse = true;
    const signer = await HttpRemoteEvmSigner.create(
      new HttpSignerClient(serverUrl, TOKEN),
      CHAIN,
      wallet.address,
    );
    const signerError = await getError(
      signer.signTransaction({
        chainId: CHAIN_ID,
        nonce: 0,
        gasLimit: 21_000,
        gasPrice: 1,
        to: wallet.address,
        value: 1,
      }),
    );
    expect(signerError.message).to.include(
      'modified the Ethereum transaction payload',
    );
  });

  it('rejects personal-message signing', async () => {
    const signer = await HttpRemoteEvmSigner.create(
      new HttpSignerClient(serverUrl, TOKEN),
      CHAIN,
      wallet.address,
    );
    const error = await getError(signer.signMessage('hello'));
    expect(error.message).to.include(
      'Personal message signing is not supported',
    );
  });
});

describe('HTTP EVM signer unsupported chains', () => {
  const signerUrl = `http://127.0.0.1:3333#${Wallet.createRandom().address}`;
  const metadata = {
    tron: {
      chainId: 1,
      domainId: 1,
      name: 'tron',
      protocol: ProtocolType.Tron,
      rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
    },
    zksync: {
      chainId: 2,
      domainId: 2,
      name: 'zksync',
      protocol: ProtocolType.Ethereum,
      technicalStack: ChainTechnicalStack.ZkSync,
      rpcUrls: [{ http: 'http://127.0.0.1:8546' }],
    },
  };

  for (const [chain, protocol, message] of [
    ['tron', ProtocolType.Tron, 'does not support Tron'],
    ['zksync', ProtocolType.Ethereum, 'does not support zkSync'],
  ] as const) {
    it(`rejects ${chain} before contacting the server`, async () => {
      const strategy = MultiProtocolSignerFactory.getSignerStrategy(
        protocol,
        new MultiProtocolProvider(metadata),
      );
      const error = await getError(
        strategy.getSigner({ chain, privateKey: signerUrl }),
      );
      expect(error.message).to.include(message);
    });
  }
});
