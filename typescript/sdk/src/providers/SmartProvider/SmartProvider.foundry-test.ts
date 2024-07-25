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

  // it('throws with invalid RPC', async () => {
  //   const INVALID_URL = 'http://1337.1337.1337.1:8545';
  //   const NETWORK = 11337;
  //   const smartProvider = HyperlaneSmartProvider.fromRpcUrl(
  //     NETWORK,
  //     INVALID_URL,
  //     {
  //       maxRetries: 3,
  //     },
  //   );
  //   const signer = new Wallet(PK, smartProvider);

  //   try {
  //     const factory = new ERC20__factory(signer);
  //     await factory.deploy('fake', 'FAKE');
  //   } catch (e: any) {
  //     expect(e.message).to.equal(
  //       getSmartProviderErrorMessage(EthersError.SERVER_ERROR),
  //     );
  //   }
  // });

  // it('throws with multiple invalid RPCs', async () => {
  //   const INVALID_URL_1 = 'http://1337.1337.1337.1:8545';
  //   const INVALID_URL_2 = 'http://1338.1338.1338.1:8545';
  //   const NETWORK = 11337;
  //   const smartProvider = new HyperlaneSmartProvider(
  //     NETWORK,
  //     [{ http: INVALID_URL_1 }, { http: INVALID_URL_2 }],
  //     [],
  //     {
  //       maxRetries: 3,
  //     },
  //   );
  //   const signer = new Wallet(PK, smartProvider);

  //   try {
  //     const factory = new ERC20__factory(signer);
  //     await factory.deploy('fake', 'FAKE');
  //   } catch (e: any) {
  //     expect(e.message).to.equal(
  //       getSmartProviderErrorMessage(EthersError.SERVER_ERROR),
  //     );
  //   }
  // });

  // it('handles invalid and valid RPCs', async () => {
  //   const INVALID_URL = 'http://1337.1337.1337.1:8545';
  //   const NETWORK = 11337;
  //   const smartProvider = new HyperlaneSmartProvider(
  //     NETWORK,
  //     [{ http: INVALID_URL }, { http: URL }],
  //     [],
  //     {
  //       maxRetries: 3,
  //     },
  //   );
  //   const signer = new Wallet(PK, smartProvider);

  //   const factory = new ERC20__factory(signer);
  //   const erc20 = await factory.deploy('fake', 'FAKE');

  //   expect(erc20.address).to.not.be.empty;
  // });
});
