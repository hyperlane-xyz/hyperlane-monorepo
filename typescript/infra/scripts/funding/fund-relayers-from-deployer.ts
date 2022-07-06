import { Console } from 'console';
import { ethers } from 'ethers';

import { ChainConnection, CompleteChainMap } from '@abacus-network/sdk';

import { AgentKey, ReadOnlyAgentKey } from '../../src/agents/agent';
import { getRelayerKeys } from '../../src/agents/key-utils';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { readJSONAtPath } from '../../src/utils/utils';
import {
  assertEnvironment,
  getArgs,
  getContextAgentConfig,
  getCoreEnvironmentConfig,
} from '../utils';

// Min delta is 1/10 of the desired balance
const MIN_DELTA_NUMERATOR = ethers.BigNumber.from(1);
const MIN_DELTA_DENOMINATOR = ethers.BigNumber.from(10);

const console = new Console({
  stdout: process.stdout,
  stderr: process.stderr,
  groupIndentation: 4,
});

const desiredBalancePerChain: CompleteChainMap<string> = {
  celo: '0.1',
  alfajores: '1',
  avalanche: '0.1',
  fuji: '1',
  ethereum: '0.2',
  kovan: '0.1',
  polygon: '1',
  mumbai: '0.5',
  optimism: '0.05',
  optimismkovan: '0.1',
  arbitrum: '0.01',
  arbitrumrinkeby: '0.1',
  bsc: '0.01',
  bsctestnet: '1',
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

  const minDelta = desiredBalanceEther
    .mul(MIN_DELTA_NUMERATOR)
    .div(MIN_DELTA_DENOMINATOR);

  const relayerInfo = {
    address: relayer.address,
    chain: relayer.chainName,
  };

  if (delta.gt(minDelta)) {
    console.log({
      relayer: relayerInfo,
      amount: ethers.utils.formatEther(delta),
      message: 'Sending relayer funds...',
    });
    const tx = await chainConnection.signer!.sendTransaction({
      to: relayer.address,
      value: delta,
      ...chainConnection.overrides,
    });
    console.log({
      relayer: relayerInfo,
      txUrl: chainConnection.getTxUrl(tx),
      message: 'Sent transaction',
    });
    const receipt = await tx.wait(chainConnection.confirmations);
    console.log({
      relayer: relayerInfo,
      receipt,
      message: 'Got transaction receipt',
    });
  }

  console.log({
    relayer: relayerInfo,
    balance: ethers.utils.formatEther(
      await chainConnection.provider.getBalance(relayer.address),
    ),
    message: 'Relayer balance',
  });
}

async function main() {
  const argv = await getArgs()
    .alias('f', 'addresses-file')
    .describe(
      'f',
      'File continaining a JSON array of identifier and address objects',
    )
    .string('f').argv;

  const environment = assertEnvironment(argv.e as string);
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const agentConfig = await getContextAgentConfig(config);

  const relayerKeys = argv.f
    ? getRelayerKeysFromSerializedAddressFile(argv.f)
    : getRelayerKeys(agentConfig);

  const chains = relayerKeys.map((key) => key.chainName!);

  for (const chain of chains) {
    const chainConnection = multiProvider.getChainConnection(chain);

    const desiredBalance = desiredBalancePerChain[chain];

    console.group({
      chain,
      funder: {
        address: await chainConnection.getAddress(),
        balance: ethers.utils.formatEther(
          await chainConnection.signer!.getBalance(),
        ),
        desiredRelayerBalance: desiredBalance,
      },
      message: 'Funding relayers on chain...',
    });

    for (const relayerKey of relayerKeys.filter(
      (key) => key.chainName !== chain,
    )) {
      await relayerKey.fetch();
      await fundRelayer(chainConnection, relayerKey, desiredBalance);
    }

    console.groupEnd();
    console.log('\n');
  }
}

function getRelayerKeysFromSerializedAddressFile(path: string): AgentKey[] {
  console.log(`Reading keys from file ${path}...`);
  // Should be an array of { identifier: '', address: '' }
  const idAndAddresses = readJSONAtPath(path);

  return idAndAddresses
    .map((idAndAddress: any) =>
      ReadOnlyAgentKey.fromSerializedAddress(
        idAndAddress.identifier,
        idAndAddress.address,
      ),
    )
    .filter((key: AgentKey) => key.role === KEY_ROLE_ENUM.Relayer);
}

main().catch(console.error);
