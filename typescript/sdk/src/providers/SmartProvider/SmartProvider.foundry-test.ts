import { expect } from 'chai';
import { NonceManager, Wallet, ZeroAddress } from 'ethers';

import { ERC20__factory } from '@hyperlane-xyz/core';

import { randomAddress } from '../../test/testUtils.js';

import {
  HyperlaneSmartProvider,
  getSmartProviderErrorMessage,
} from './SmartProvider.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const NETWORK = 31337;
const URL = 'http://127.0.0.1:8545';
const EthersError = {
  SERVER_ERROR: 'SERVER_ERROR',
  CALL_EXCEPTION: 'CALL_EXCEPTION',
  UNPREDICTABLE_GAS_LIMIT: 'UNPREDICTABLE_GAS_LIMIT',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
} as const;

function getErrorCode(error: any): string | undefined {
  return (
    error?.cause?.code ??
    error?.error?.cause?.code ??
    error?.error?.code ??
    error?.code
  );
}

describe('SmartProvider', function () {
  this.timeout(10_000);
  let smartProvider: HyperlaneSmartProvider;
  let snapshotId: string;

  before(async () => {
    smartProvider = HyperlaneSmartProvider.fromRpcUrl(NETWORK, URL, {
      maxRetries: 3,
    });
  });

  beforeEach(async () => {
    snapshotId = await smartProvider.rpcProviders[0].send('evm_snapshot', []);
  });

  afterEach(async () => {
    await smartProvider.rpcProviders[0].send('evm_revert', [snapshotId]);
  });

  after(async () => {
    await smartProvider.destroy();
  });

  it('Sends transactions', async () => {
    const signer = new NonceManager(new Wallet(PK, smartProvider));
    const signerAddress = await signer.getAddress();
    const response = await signer.sendTransaction({
      to: signerAddress,
      value: 1,
    });
    expect(response.hash.substring(0, 2)).to.equal('0x');
    expect(response.hash.length).to.equal(66);
    await response.wait();
  });

  it('Deploys contracts', async () => {
    const signer = new NonceManager(new Wallet(PK, smartProvider));
    const factory = new ERC20__factory(signer);
    const contract = await factory.deploy('fake', 'FAKE');
    const contractAddress = await contract.getAddress();
    expect(contractAddress.substring(0, 2)).to.equal('0x');
    expect(contractAddress.length).to.equal(42);
  });

  it('Handles multiple requests', async () => {
    const signer = new NonceManager(new Wallet(PK, smartProvider));
    const signerAddress = await signer.getAddress();
    const factory = new ERC20__factory(signer);
    const contract = await factory.deploy('fake', 'FAKE');
    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();

    const [
      isHealthy,
      blockNum,
      block,
      balance,
      feeData,
      code,
      txCount,
      network,
      logs,
    ] = await Promise.all([
      smartProvider.isHealthy(),
      smartProvider.getBlockNumber(),
      smartProvider.getBlock('latest'),
      smartProvider.getBalance(signerAddress),
      smartProvider.getFeeData(),
      smartProvider.getCode(contractAddress),
      smartProvider.getTransactionCount(signerAddress),
      smartProvider.getNetwork(),
      smartProvider.getLogs({
        fromBlock: 0,
        address: ZeroAddress,
        topics: [],
      }),
    ]);

    expect(isHealthy).to.be.true;
    expect(blockNum).to.be.at.least(0);
    expect(block.number).to.be.at.least(blockNum);
    expect(balance > 0n).to.be.true;
    expect(feeData.gasPrice && feeData.gasPrice > 0n).to.be.true;
    expect(feeData.maxFeePerGas && feeData.maxFeePerGas > 0n).to.be.true;
    expect(code.length).to.greaterThan(10);
    expect(txCount).to.be.greaterThan(0);
    expect(Number(network.chainId)).to.equal(NETWORK);
    expect(Array.isArray(logs)).to.be.true;
  });

  it('throws with invalid RPC', async () => {
    const INVALID_URL = 'http://127.0.0.1:33337';
    const INVALID_NETWORK = 55555;
    const smartProvider = HyperlaneSmartProvider.fromRpcUrl(
      INVALID_NETWORK,
      INVALID_URL,
    );
    const signer = new Wallet(PK, smartProvider);
    try {
      const factory = new ERC20__factory(signer);
      await factory.deploy('fake', 'FAKE');
      expect.fail('Expected deploy to fail with invalid RPC');
    } catch (e: any) {
      expect([EthersError.SERVER_ERROR, 'ECONNREFUSED']).to.include(
        getErrorCode(e),
      );
      expect(e.message).to.equal(
        getSmartProviderErrorMessage(EthersError.SERVER_ERROR),
      );
    } finally {
      await smartProvider.destroy();
    }
  });

  it('throws with multiple invalid RPCs', async () => {
    const INVALID_URL_1 = 'http://127.0.0.1:33337';
    const INVALID_URL_2 = 'http://127.0.0.1:23337';
    const INVALID_NETWORK = 55555;
    const smartProvider = new HyperlaneSmartProvider(
      INVALID_NETWORK,
      [{ http: INVALID_URL_1 }, { http: INVALID_URL_2 }],
      [],
    );
    const signer = new Wallet(PK, smartProvider);

    try {
      const factory = new ERC20__factory(signer);
      await factory.deploy('fake', 'FAKE');
      expect.fail('Expected deploy to fail with invalid RPCs');
    } catch (e: any) {
      expect([EthersError.SERVER_ERROR, 'ECONNREFUSED']).to.include(
        getErrorCode(e),
      );
      expect(e.message).to.equal(
        getSmartProviderErrorMessage(EthersError.SERVER_ERROR),
      );
    } finally {
      await smartProvider.destroy();
    }
  });

  it('handles invalid and valid RPCs', async () => {
    const INVALID_URL = 'http://127.0.0.1:33331337';
    const smartProvider = new HyperlaneSmartProvider(
      NETWORK,
      [{ http: INVALID_URL }, { http: URL }],
      [],
      {
        maxRetries: 3,
      },
    );
    const signer = new Wallet(PK, smartProvider);

    const factory = new ERC20__factory(signer);
    const erc20 = await factory.deploy('fake', 'FAKE');

    expect(await erc20.getAddress()).to.not.be.empty;
    await smartProvider.destroy();
  });

  it('returns the blockchain error reason: "ERC20: transfer to zero address"', async () => {
    const smartProvider = HyperlaneSmartProvider.fromRpcUrl(NETWORK, URL, {
      maxRetries: 1,
    });
    const signer = new NonceManager(new Wallet(PK, smartProvider));

    const factory = new ERC20__factory(signer);
    const token = await factory.deploy('fake', 'FAKE');
    try {
      await token.transfer(ZeroAddress, 1000000);
      expect.fail('Expected transfer to zero address to revert');
    } catch (e: any) {
      expect([
        EthersError.CALL_EXCEPTION,
        EthersError.UNPREDICTABLE_GAS_LIMIT,
      ]).to.include(getErrorCode(e));
      expect(e.message).to.include('ERC20: transfer to the zero address');
    } finally {
      await smartProvider.destroy();
    }
  });

  it('returns the blockchain error reason: "ERC20: transfer amount exceeds balance"', async () => {
    const smartProvider = HyperlaneSmartProvider.fromRpcUrl(NETWORK, URL, {
      maxRetries: 1,
    });
    const signer = new NonceManager(new Wallet(PK, smartProvider));
    const factory = new ERC20__factory(signer);
    const token = await factory.deploy('fake', 'FAKE');

    try {
      await token.transfer(await signer.getAddress(), 1000000);
      expect.fail('Expected transfer over balance to revert');
    } catch (e: any) {
      expect([
        EthersError.CALL_EXCEPTION,
        EthersError.UNPREDICTABLE_GAS_LIMIT,
      ]).to.include(getErrorCode(e));
      expect(e.message).to.include('ERC20: transfer amount exceeds balance');
    } finally {
      await smartProvider.destroy();
    }
  });

  it('returns the blockchain error reason: "insufficient funds for intrinsic transaction cost"', async () => {
    const smartProvider = HyperlaneSmartProvider.fromRpcUrl(NETWORK, URL, {
      maxRetries: 1,
    });
    const signer = new NonceManager(new Wallet(PK, smartProvider));

    try {
      const signerAddress = await signer.getAddress();
      const balance = await smartProvider.getBalance(signerAddress);
      // sendTransaction uses the Provider (SmartProvider in this case)
      await signer.sendTransaction({
        to: randomAddress(),
        value: balance + 1n,
      });
      expect.fail('Expected insufficient funds error');
    } catch (e: any) {
      expect([EthersError.INSUFFICIENT_FUNDS, undefined]).to.include(
        getErrorCode(e),
      );
      const message = e.message.toLowerCase();
      expect(
        message.includes('insufficient funds') ||
          message.includes('insufficient_funds'),
      ).to.equal(true);
    } finally {
      await smartProvider.destroy();
    }
  });
});
