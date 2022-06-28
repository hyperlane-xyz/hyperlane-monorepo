import { ethers } from 'ethers';

import { ChainConnection, CompleteChainMap } from '@abacus-network/sdk';

import { AgentKey } from '../src/agents/agent';
import { getRelayerKeys } from '../src/agents/key-utils';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

const MIN_DELTA = ethers.utils.parseUnits('0.001', 'ether');

const desiredBalancePerChain: CompleteChainMap<string> = {
  celo: '0.05',
  alfajores: '0.1',
  avalanche: '0.1',
  fuji: '0.1',
  ethereum: '0.1',
  kovan: '0.1',
  polygon: '1',
  mumbai: '0.1',
  optimism: '0.05',
  optimismkovan: '0.1',
  arbitrum: '0.01',
  arbitrumrinkeby: '0.1',
  bsc: '0.01',
  bsctestnet: '0.1',
  // unused
  goerli: '0',
  auroratestnet: '0',
  test1: '0',
  test2: '0',
  test3: '0',
};

async function fundRelayer(
  chainConnection: ChainConnection,
  relayer: AgentKey,
  desiredBalance: string,
) {
  const currentBalance = await chainConnection.provider.getBalance(
    relayer.address,
  );
  const desiredBalanceEther = ethers.utils.parseUnits(desiredBalance, 'ether');
  const delta = desiredBalanceEther.sub(currentBalance);

  if (delta.gt(MIN_DELTA)) {
    console.log(
      `sending ${relayer.chainName} relayer ${ethers.utils.formatEther(
        delta,
      )}...`,
    );
    const tx = await chainConnection.signer!.sendTransaction({
      to: relayer.address,
      value: delta,
      ...chainConnection.overrides,
    });
    console.log(chainConnection.getTxUrl(tx));
    await tx.wait(chainConnection.confirmations);
  }

  console.log(
    `${relayer.chainName} relayer : ${ethers.utils.formatEther(
      await chainConnection.provider.getBalance(relayer.address),
    )}`,
  );
}

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const relayerKeys = getRelayerKeys(config.agent);

  const chains = relayerKeys.map((key) => key.chainName!);

  for (const chain of chains) {
    const chainConnection = multiProvider.getChainConnection(chain);

    const desiredBalance = desiredBalancePerChain[chain];

    console.group(
      chain,
      `funder : ${ethers.utils.formatEther(
        await chainConnection.signer!.getBalance(),
      )} relayer desired : ${desiredBalance}`,
    );

    for (const relayerKey of relayerKeys.filter(
      (key) => key.chainName !== chain,
    )) {
      await relayerKey.fetch();
      await fundRelayer(chainConnection, relayerKey, desiredBalance);
    }

    console.groupEnd();
  }
}

main().catch(console.error);
