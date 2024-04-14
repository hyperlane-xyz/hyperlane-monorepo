/* eslint-disable no-console */
import { expect } from 'chai';
import { ethers } from 'ethers';

import { eqAddress } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../../consts/chainMetadata.js';
import { ChainMetadata } from '../../metadata/chainMetadataTypes.js';

import { ProviderMethod } from './ProviderMethods.js';
import { HyperlaneSmartProvider } from './SmartProvider.js';

const DEFAULT_ACCOUNT = '0xfaD1C94469700833717Fa8a3017278BC1cA8031C';
const WETH_CONTRACT = '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9';
const WETH_TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WETH_CALL_DATA =
  '0x70a082310000000000000000000000004f7a67464b5976d7547c860109e4432d50afb38e';
const TRANSFER_TX_HASH =
  '0x7a975792c023733b3013ada23e1f556f5a06443765ec576e56d0b0aa3c4bdc74';

const pagination = { maxBlockRange: 1000 };
const sepoliaRpcConfig1 = { ...chainMetadata.sepolia.rpcUrls[0], pagination };
const sepoliaRpcConfig2 = { ...chainMetadata.sepolia.rpcUrls[1], pagination };
const justExplorersConfig: ChainMetadata = {
  ...chainMetadata.sepolia,
  rpcUrls: [] as any,
};
const justRpcsConfig: ChainMetadata = {
  ...chainMetadata.sepolia,
  rpcUrls: [sepoliaRpcConfig1, sepoliaRpcConfig2],
  blockExplorers: [],
};
const combinedConfig: ChainMetadata = {
  ...chainMetadata.sepolia,
  rpcUrls: [sepoliaRpcConfig1],
};
const configs: [string, ChainMetadata][] = [
  ['Just Explorers', justExplorersConfig],
  ['Just RPCs', justRpcsConfig],
  ['Combined configs', combinedConfig],
];

describe.skip('SmartProvider', () => {
  let provider: HyperlaneSmartProvider;

  const itDoesIfSupported = (method: ProviderMethod, fn: () => any) => {
    it(method, () => {
      if (provider.supportedMethods.includes(method)) {
        return fn();
      }
    }).timeout(30_000);
  };

  for (const [description, config] of configs) {
    describe(description, () => {
      provider = HyperlaneSmartProvider.fromChainMetadata(config, {
        debug: true,
        baseRetryDelayMs: 1000,
        fallbackStaggerMs: 3000,
        maxRetries: 3,
      });

      itDoesIfSupported(ProviderMethod.GetBlock, async () => {
        const latestBlock = await provider.getBlock('latest');
        console.debug('Latest block #', latestBlock.number);
        expect(latestBlock.number).to.be.greaterThan(0);
        expect(latestBlock.timestamp).to.be.greaterThan(
          Date.now() / 1000 - 60 * 60 * 24,
        );
        const firstBlock = await provider.getBlock(1);
        expect(firstBlock.number).to.equal(1);
      });

      itDoesIfSupported(ProviderMethod.GetBlockNumber, async () => {
        const result = await provider.getBlockNumber();
        console.debug('Latest block #', result);
        expect(result).to.be.greaterThan(0);
      });

      itDoesIfSupported(ProviderMethod.GetGasPrice, async () => {
        const result = await provider.getGasPrice();
        console.debug('Gas price', result.toString());
        expect(result.toNumber()).to.be.greaterThan(0);
      });

      itDoesIfSupported(ProviderMethod.GetBalance, async () => {
        const result = await provider.getBalance(DEFAULT_ACCOUNT);
        console.debug('Balance', result.toString());
        expect(parseFloat(ethers.utils.formatEther(result))).to.be.greaterThan(
          1,
        );
      });

      itDoesIfSupported(ProviderMethod.GetCode, async () => {
        const result = await provider.getCode(WETH_CONTRACT);
        console.debug('Weth code snippet', result.substring(0, 12));
        expect(result.length).to.be.greaterThan(100);
      });

      itDoesIfSupported(ProviderMethod.GetStorageAt, async () => {
        const result = await provider.getStorageAt(WETH_CONTRACT, 0);
        console.debug('Weth storage', result);
        expect(result.length).to.be.greaterThan(20);
      });

      itDoesIfSupported(ProviderMethod.GetTransactionCount, async () => {
        const result = await provider.getTransactionCount(
          DEFAULT_ACCOUNT,
          'latest',
        );
        console.debug('Tx Count', result);
        expect(result).to.be.greaterThan(40);
      });

      itDoesIfSupported(ProviderMethod.GetTransaction, async () => {
        const result = await provider.getTransaction(TRANSFER_TX_HASH);
        console.debug('Transaction confirmations', result.confirmations);
        expect(result.confirmations).to.be.greaterThan(1000);
      });

      itDoesIfSupported(ProviderMethod.GetTransactionReceipt, async () => {
        const result = await provider.getTransactionReceipt(TRANSFER_TX_HASH);
        console.debug('Transaction receipt', result.confirmations);
        expect(result.confirmations).to.be.greaterThan(1000);
      });

      itDoesIfSupported(ProviderMethod.GetLogs, async () => {
        const latestBlockNumber = await provider.getBlockNumber();
        const minBlockNumber = latestBlockNumber - 10_000;

        console.debug('Testing logs with small from/to range');
        const result1 = await provider.getLogs({
          address: WETH_CONTRACT,
          topics: [WETH_TRANSFER_TOPIC0],
          fromBlock: minBlockNumber,
          toBlock: minBlockNumber + 100,
        });
        expect(result1.length).to.be.greaterThan(0);
        expect(eqAddress(result1[0].address, WETH_CONTRACT)).to.be.true;

        console.debug('Testing logs with large from/to range');
        const result2 = await provider.getLogs({
          address: WETH_CONTRACT,
          topics: [WETH_TRANSFER_TOPIC0],
          fromBlock: minBlockNumber,
          toBlock: 'latest',
        });
        expect(result2.length).to.be.greaterThan(0);
        expect(eqAddress(result2[0].address, WETH_CONTRACT)).to.be.true;
      });

      itDoesIfSupported(ProviderMethod.EstimateGas, async () => {
        const result = await provider.estimateGas({
          to: DEFAULT_ACCOUNT,
          from: DEFAULT_ACCOUNT,
          value: 1,
        });
        expect(result.toNumber()).to.be.greaterThan(10_000);
      });

      itDoesIfSupported(ProviderMethod.Call, async () => {
        const result = await provider.call({
          to: WETH_CONTRACT,
          from: DEFAULT_ACCOUNT,
          data: WETH_CALL_DATA,
        });
        expect(result).to.equal(
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        );
      });

      it('Handles parallel requests', async () => {
        const result1Promise = provider.call({
          to: WETH_CONTRACT,
          from: DEFAULT_ACCOUNT,
          data: WETH_CALL_DATA,
        });
        const result2Promise = provider.getBlockNumber();
        const result3Promise = provider.getTransaction(TRANSFER_TX_HASH);
        const [result1, result2, result3] = await Promise.all([
          result1Promise,
          result2Promise,
          result3Promise,
        ]);
        expect(result1.length).to.be.greaterThan(0);
        expect(result2).to.be.greaterThan(0);
        expect(!!result3).to.be.true;
      }).timeout(15_000);
    });

    it('Reports as healthy', async () => {
      const result = await provider.isHealthy();
      expect(result).to.be.true;
    });
  }
});
