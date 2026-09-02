import Safe, { EthSafeTransaction } from '@safe-global/protocol-kit';
import { OperationType } from '@safe-global/types-kit';
import { expect } from 'chai';
import { Signer, Wallet, ethers } from 'ethers';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../../MultiProvider.js';
import {
  EV5GnosisSafeTxSubmitter,
  signSafeTransactionWithSigner,
} from './EV5GnosisSafeTxSubmitter.js';

class HttpStyleTypedDataSigner extends Signer {
  typedDataCalls = 0;
  lastSignature?: string;

  constructor(private readonly wallet: Wallet) {
    super();
  }

  getAddress(): Promise<string> {
    return this.wallet.getAddress();
  }

  signMessage(): Promise<string> {
    throw new Error('not implemented');
  }

  signTransaction(): Promise<string> {
    throw new Error('not implemented');
  }

  connect(): Signer {
    return this;
  }

  async _signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<ethers.TypedDataField>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    this.typedDataCalls += 1;
    this.lastSignature = await this.wallet._signTypedData(domain, types, value);
    return this.lastSignature;
  }
}

describe('signSafeTransactionWithSigner', () => {
  const wallet = Wallet.createRandom();
  const privateKey = wallet.privateKey;
  const contractAddress = '0x0000000000000000000000000000000000000001';
  const safeVersion = '1.4.1';
  const chainId = 31337n;
  const transaction = new EthSafeTransaction({
    to: '0x0000000000000000000000000000000000000002',
    value: '3',
    data: '0x12345678',
    operation: OperationType.Call,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: '0x0000000000000000000000000000000000000000',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce: 7,
  });

  async function createLocalSignerSafe() {
    // Safe only calls proxyCreationCode while initializing a predicted
    // account. The mocked chain still exercises Protocol Kit's real local
    // signer and Safe.signTypedData implementation.
    const encodedProxyCreationCode = ethers.utils.defaultAbiCoder.encode(
      ['bytes'],
      ['0x00'],
    );
    const provider = {
      async request({ method }: { method: string }) {
        switch (method) {
          case 'eth_chainId':
            return `0x${chainId.toString(16)}`;
          case 'eth_getCode':
            return '0x01';
          case 'eth_call':
            return encodedProxyCreationCode;
          case 'eth_getTransactionCount':
            return '0x0';
          default:
            throw new Error(`Unexpected test RPC method ${method}`);
        }
      },
    };
    const contractNetwork = {
      safeSingletonAddress: contractAddress,
      safeProxyFactoryAddress: contractAddress,
      multiSendAddress: contractAddress,
      multiSendCallOnlyAddress: contractAddress,
      fallbackHandlerAddress: contractAddress,
      signMessageLibAddress: contractAddress,
      createCallAddress: contractAddress,
      simulateTxAccessorAddress: contractAddress,
    };

    // @ts-expect-error protocol-kit exposes its default class directly at runtime.
    return Safe.init({
      provider,
      signer: privateKey,
      predictedSafe: {
        safeAccountConfig: { owners: [wallet.address], threshold: 1 },
        safeDeploymentConfig: { safeVersion },
      },
      contractNetworks: { [chainId.toString()]: contractNetwork },
    });
  }

  it('matches Protocol Kit local-key signing byte-for-byte', async () => {
    const safe = await createLocalSignerSafe();
    const expected = (await safe.signTypedData(transaction)).data;
    expect(
      await signSafeTransactionWithSigner(safe, transaction, wallet),
    ).to.equal(expected);
  });

  it('rejects signers without typed-data support', async () => {
    const safe = await createLocalSignerSafe();
    const signer: Signer = Object.create(wallet);
    Object.defineProperty(signer, '_signTypedData', { value: undefined });

    let error: Error | undefined;
    try {
      await signSafeTransactionWithSigner(safe, transaction, signer);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    expect(error?.message).to.include('must support EIP-712');
  });

  it('proposes the exact signature from an external typed-data signer', async () => {
    const safe = await createLocalSignerSafe();
    const signer = new HttpStyleTypedDataSigner(wallet);
    const multiProvider = new MultiProvider({
      test: {
        chainId: Number(chainId),
        domainId: Number(chainId),
        name: 'test',
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
      },
    });
    multiProvider.setSigner('test', signer);

    let proposal: Record<string, unknown> | undefined;
    const safeService = Object.create(null);
    safeService.getNextNonce = async () => '11';
    safeService.proposeTransaction = async (value: Record<string, unknown>) => {
      proposal = value;
    };
    const submitter = new EV5GnosisSafeTxSubmitter(
      multiProvider,
      { chain: 'test', safeAddress: await safe.getAddress() },
      safe,
      safeService,
    );

    await submitter.submit({
      chainId: Number(chainId),
      to: transaction.data.to,
      value: ethers.BigNumber.from(transaction.data.value),
      data: transaction.data.data,
    });

    expect(signer.typedDataCalls).to.equal(1);
    expect(proposal).to.not.equal(undefined);
    expect(proposal?.senderAddress).to.equal(wallet.address);
    expect(proposal?.senderSignature).to.equal(signer.lastSignature);
    expect(proposal?.safeAddress).to.equal(await safe.getAddress());
  });
});
