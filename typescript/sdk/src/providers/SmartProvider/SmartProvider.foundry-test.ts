import { expect } from 'chai';
import { errors as EthersError, Wallet, constants } from 'ethers';

import { ERC20__factory } from '@hyperlane-xyz/core';
import { randomInt } from '@hyperlane-xyz/utils';

import { randomAddress } from '../../test/testUtils.js';

import {
  HyperlaneSmartProvider,
  TX_ERROR_MESSAGE_PHRASES,
  getSmartProviderErrorMessage,
  hasNonRetryableError,
} from './SmartProvider.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const NETWORK = 31337;
const URL = 'http://127.0.0.1:8545';

describe('SmartProvider', async () => {
  const maxRetries = randomInt(50, 0);
  let signer: Wallet;
  let smartProvider: HyperlaneSmartProvider;
  let contractAddress: string;

  before(async () => {
    smartProvider = HyperlaneSmartProvider.fromRpcUrl(NETWORK, URL, {
      maxRetries: 3,
    });
    signer = new Wallet(PK, smartProvider);
  });

  it('Sends transactions', async () => {
    const transferTx = await signer.populateTransaction({
      to: signer.address,
      value: 1,
    });
    const signedTx = await signer.signTransaction(transferTx);
    const response = await smartProvider.sendTransaction(signedTx);
    expect(response.hash.substring(0, 2)).to.equal('0x');
    expect(response.hash.length).to.equal(66);
  });

  it('Deploys contracts', async () => {
    const factory = new ERC20__factory(signer);
    const contract = await factory.deploy('fake', 'FAKE');
    contractAddress = contract.address;
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
      smartProvider.getBalance(signer.address),
      smartProvider.getGasPrice(),
      smartProvider.getFeeData(),
      smartProvider.getCode(contractAddress),
      smartProvider.getTransactionCount(signer.address),
      smartProvider.getNetwork(),
      smartProvider.getLogs({
        fromBlock: 0,
        address: constants.AddressZero,
        topics: [],
      }),
    ]);

    expect(isHealthy).to.be.true;
    expect(blockNum).to.greaterThan(0);
    expect(block.number).to.equal(1);
    expect(balance.toBigInt() > 0).to.be.true;
    expect(gasPrice.toBigInt() > 0).to.be.true;
    expect(feeData.maxFeePerGas && feeData.maxFeePerGas.toBigInt() > 0).to.be
      .true;
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
    const signer = new Wallet(PK, smartProvider);

    try {
      const factory = new ERC20__factory(signer);
      await factory.deploy('fake', 'FAKE');
    } catch (e: any) {
      expect(e.message).to.equal(
        getSmartProviderErrorMessage(EthersError.SERVER_ERROR),
      );
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
    const signer = new Wallet(PK, smartProvider);

    try {
      const factory = new ERC20__factory(signer);
      await factory.deploy('fake', 'FAKE');
    } catch (e: any) {
      expect(e.message).to.equal(
        getSmartProviderErrorMessage(EthersError.SERVER_ERROR),
      );
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

    expect(erc20.address).to.not.be.empty;
  });

  it(`returns the blockchain error reason: "ERC20: transfer to zero address" with ${maxRetries} retries`, async () => {
    const smartProvider = HyperlaneSmartProvider.fromRpcUrl(NETWORK, URL, {
      maxRetries,
    });
    const signer = new Wallet(PK, smartProvider);

    const factory = new ERC20__factory(signer);
    const token = await factory.deploy('fake', 'FAKE');
    try {
      await token.transfer(constants.AddressZero, 1000000);
    } catch (e: any) {
      expect(e.error.message).to.equal(
        'execution reverted: revert: ERC20: transfer to the zero address',
      );
    }
  });

  it(`returns the blockchain error reason: "ERC20: transfer amount exceeds balance with ${maxRetries} retries"`, async () => {
    const smartProvider = HyperlaneSmartProvider.fromRpcUrl(NETWORK, URL, {
      maxRetries,
    });
    const signer = new Wallet(PK, smartProvider);

    const factory = new ERC20__factory(signer);
    const token = await factory.deploy('fake', 'FAKE');
    try {
      await token.transfer(signer.address, 1000000);
    } catch (e: any) {
      expect(e.error.message).to.equal(
        'execution reverted: revert: ERC20: transfer amount exceeds balance',
      );
    }
  });

  it(`returns the blockchain error reason: "insufficient funds for intrinsic transaction cost" with ${maxRetries} retries`, async () => {
    const smartProvider = HyperlaneSmartProvider.fromRpcUrl(NETWORK, URL, {
      maxRetries,
    });
    const signer = new Wallet(PK, smartProvider);

    try {
      const balance = await signer.getBalance();
      await signer.sendTransaction({
        to: randomAddress(),
        value: balance.add(1),
      });
    } catch (e: any) {
      expect(e.message).to.equal(
        'insufficient funds for intrinsic transaction cost',
      );
    }
  });

  describe('hasNonRetryableError', () => {
    it('returns true for revert errors on call methods', () => {
      const result = hasNonRetryableError({
        method: 'call',
        error: new Error(
          `Transaction reverted: ${TX_ERROR_MESSAGE_PHRASES.Revert}`,
        ),
      });
      expect(result).to.be.true;
    });

    it('returns true for revert errors on estimateGas', () => {
      const result = hasNonRetryableError({
        method: 'estimateGas',
        error: new Error(
          `Transaction reverted: ${TX_ERROR_MESSAGE_PHRASES.Revert}`,
        ),
      });
      expect(result).to.be.true;
    });

    it('returns true for known errors', () => {
      const result = hasNonRetryableError({
        method: 'sendTransaction',
        error: new Error(`Transaction ${TX_ERROR_MESSAGE_PHRASES.Known}`),
      });
      expect(result).to.be.true;
    });

    it('returns true for nonce errors', () => {
      const result = hasNonRetryableError({
        method: 'sendRawTransaction',
        error: new Error(`Transaction ${TX_ERROR_MESSAGE_PHRASES.Nonce}`),
      });
      expect(result).to.be.true;
    });

    it('returns true for underpriced errors', () => {
      const result = hasNonRetryableError({
        method: 'sendTransaction',
        error: new Error(`Transaction ${TX_ERROR_MESSAGE_PHRASES.Underpriced}`),
      });
      expect(result).to.be.true;
    });

    it('returns true for insufficient funds errors', () => {
      const result = hasNonRetryableError({
        method: 'sendTransaction',
        error: new Error(
          `Transaction ${TX_ERROR_MESSAGE_PHRASES.InsufficientFunds}`,
        ),
      });
      expect(result).to.be.true;
    });

    it('returns false for non-transaction methods', () => {
      const result = hasNonRetryableError({
        method: 'getBalance',
        error: new Error(`Transaction ${TX_ERROR_MESSAGE_PHRASES.Revert}`),
      });
      expect(result).to.be.false;
    });
  });
});
