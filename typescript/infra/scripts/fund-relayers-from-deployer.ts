import { ethers } from 'hardhat';

import {
  ChainConnection,
  ChainName,
  CompleteChainMap,
} from '@abacus-network/sdk';

import { getRelayerKeys } from '../src/agents/key-utils';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

const desiredBalancePerChain: CompleteChainMap<string> = {
  celo: '0.05',
  alfajores: '0.05',
  avalanche: '0.1',
  fuji: '0.1',
  ethereum: '0.1',
  kovan: '0.1',
  polygon: '1',
  mumbai: '1',
  optimism: '0.05',
  optimismkovan: '0.05',
  arbitrum: '0.01',
  arbitrumrinkeby: '0.01',
  bsc: '0.01',
  bsctestnet: '0.01',
  // unused
  goerli: '0',
  auroratestnet: '0',
  test1: '0',
  test2: '0',
  test3: '0',
};

async function fundAddress(
  chainConnection: ChainConnection,
  address: string,
  desiredBalance: string,
) {
  const currentBalance = await chainConnection.provider.getBalance(address);

  const desiredBalanceEther = ethers.utils.parseUnits(desiredBalance, 'ether');
  const delta = desiredBalanceEther.sub(currentBalance);
  if (delta.gt(0)) {
    const tx = await chainConnection.signer!.sendTransaction({
      to: address,
      value: delta,
      ...chainConnection.overrides,
    });
    console.log(chainConnection.getTxUrl(tx));
    await tx.wait(chainConnection.confirmations);
  }
}

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);

  const multiProvider = await config.getMultiProvider();

  const relayerKeys = getRelayerKeys(config.agent);

  for (const relayerKey of relayerKeys) {
    await relayerKey.fetch();

    for (const remote of multiProvider.remoteChains(
      relayerKey.chainName,
    ) as ChainName[]) {
      await fundAddress(
        multiProvider.getChainConnection(remote),
        relayerKey.address,
        desiredBalancePerChain[remote],
      );
    }
  }
}

main().catch(console.error);
