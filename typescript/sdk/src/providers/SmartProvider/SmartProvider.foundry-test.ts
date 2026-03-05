import { expect } from 'chai';
import { zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ERC20__factory } from '@hyperlane-xyz/core';

import { randomAddress } from '../../test/testUtils.js';

import {
  HyperlaneSmartProvider,
  getSmartProviderErrorMessage,
} from './SmartProvider.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const NETWORK = 31337;
const URL = 'http://127.0.0.1:8545';
const SERVER_ERROR = 'SERVER_ERROR';

describe('SmartProvider', function () {
  this.timeout(10_000);
  const signerAddress = privateKeyToAccount(PK).address;
  let smartProvider: HyperlaneSmartProvider;
  let contractAddress: string;

  const erc20Interface = ERC20__factory.createInterface();
  // Deploys a tiny contract with runtime bytecode:
  // `0x600060005560006000fd00` (writes storage, then reverts on calls).
  const deployData = '0x600b600c600039600b6000f3600060005560006000fd00';

  before(async () => {
    smartProvider = HyperlaneSmartProvider.fromRpcUrl(NETWORK, URL, {
      maxRetries: 3,
    });
  });

  it('Sends transactions', async () => {
    const signer = smartProvider.getSigner(signerAddress);
    const response = await signer.sendTransaction({
      to: signerAddress,
      value: 1,
    });
    expect(response.hash.substring(0, 2)).to.equal('0x');
    expect(response.hash.length).to.equal(66);
  });

  it('Deploys contracts', async () => {
    const signer = smartProvider.getSigner(signerAddress);
    const tx = await signer.sendTransaction({ data: deployData });
    const receipt = (await tx.wait()) as { contractAddress?: string };
    contractAddress = receipt.contractAddress || '';
    expect(contractAddress.substring(0, 2)).to.equal('0x');
    expect(contractAddress.length).to.equal(42);
  });

  it('Handles multiple requests', async () => {
    const [
      isHealthy,
      blockNum,
      block,
      balance,
      gasPrice,
      feeData,
      code,
      txCount,
      network,
      logs,
    ] = await Promise.all([
      smartProvider.isHealthy(),
      smartProvider.getBlockNumber(),
      smartProvider.getBlock(1),
      smartProvider.getBalance(signerAddress),
      smartProvider.getGasPrice(),
      smartProvider.getFeeData(),
      smartProvider.getCode(contractAddress),
      smartProvider.getTransactionCount(signerAddress),
      smartProvider.getNetwork(),
      smartProvider.getLogs({
        fromBlock: 0,
        address: zeroAddress,
        topics: [],
      }),
    ]);

    expect(isHealthy).to.be.true;
    expect(blockNum).to.greaterThan(0);
    expect(block.number).to.equal(1);
    expect(balance > 0n).to.be.true;
    expect(gasPrice > 0n).to.be.true;
    expect(feeData.maxFeePerGas && feeData.maxFeePerGas > 0n).to.be.true;
    expect(code.length).to.greaterThan(10);
    expect(txCount).to.be.greaterThan(0);
    expect(network.chainId).to.equal(NETWORK);
    expect(Array.isArray(logs)).to.be.true;
  });

  it('throws with invalid RPC', async () => {
    const INVALID_URL = 'http://127.0.0.1:33331337';
    const INVALID_NETWORK = 55555;
    const smartProvider = HyperlaneSmartProvider.fromRpcUrl(
      INVALID_NETWORK,
      INVALID_URL,
    );
    const signer = smartProvider.getSigner(signerAddress);

    try {
      await signer.sendTransaction({ data: deployData });
    } catch (e: any) {
      expect(e.cause.code).to.equal('SERVER_ERROR');
      expect(e.message).to.equal(getSmartProviderErrorMessage(SERVER_ERROR));
    }
  });

  it('throws with multiple invalid RPCs', async () => {
    const INVALID_URL_1 = 'http://127.0.0.1:33331337';
    const INVALID_URL_2 = 'http://127.0.0.1:23331337';
    const INVALID_NETWORK = 55555;
    const smartProvider = new HyperlaneSmartProvider(
      INVALID_NETWORK,
      [{ http: INVALID_URL_1 }, { http: INVALID_URL_2 }],
      [],
    );
    const signer = smartProvider.getSigner(signerAddress);

    try {
      await signer.sendTransaction({ data: deployData });
    } catch (e: any) {
      expect(e.cause.code).to.equal('SERVER_ERROR');
      expect(e.message).to.equal(getSmartProviderErrorMessage(SERVER_ERROR));
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
    const signer = smartProvider.getSigner(signerAddress);
    const tx = await signer.sendTransaction({ data: deployData });
    const receipt = (await tx.wait()) as { contractAddress?: string };
    expect(receipt.contractAddress).to.not.be.empty;
  });

  it('returns error when transfer call reverts', async () => {
    const signer = smartProvider.getSigner(signerAddress);
    const deployTx = await signer.sendTransaction({ data: deployData });
    const deployReceipt = (await deployTx.wait()) as {
      contractAddress?: string;
    };
    const tokenAddress = deployReceipt.contractAddress!;
    const transferData = erc20Interface.encodeFunctionData('transfer', [
      zeroAddress,
      1_000_000,
    ]);
    try {
      await smartProvider.estimateGas({
        from: signerAddress,
        to: tokenAddress,
        data: transferData,
      });
      expect.fail('Expected estimateGas to throw');
    } catch (e: any) {
      expect(e).to.exist;
    }
  });

  it('returns error for insufficient funds transaction', async () => {
    const smartProvider = HyperlaneSmartProvider.fromRpcUrl(NETWORK, URL, {
      maxRetries: 1,
    });
    const signer = smartProvider.getSigner(signerAddress);

    try {
      const balance = await smartProvider.getBalance(signerAddress);
      // sendTransaction uses the Provider (SmartProvider in this case)
      await signer.sendTransaction({
        to: randomAddress(),
        value: BigInt(balance) + 1n,
      });
    } catch (e: any) {
      expect(e.cause?.code || e.code).to.exist;
    }
  });
});
