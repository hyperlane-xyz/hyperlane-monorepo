import { expect } from 'chai';
import { Wallet, constants } from 'ethers';

import { ERC20__factory } from '@hyperlane-xyz/core';

import { HyperlaneSmartProvider } from './SmartProvider.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const NETWORK = 31337;
const URL = 'http://127.0.0.1:8545';

describe('SmartProvider', async () => {
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
});
