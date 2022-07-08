import { Console } from 'console';
import { ethers } from 'ethers';
import { Gauge, Pushgateway, Registry } from 'prom-client';

import {
  ChainConnection,
  ChainName,
  CompleteChainMap,
} from '@abacus-network/sdk';

import { AgentKey, ReadOnlyAgentKey } from '../../src/agents/agent';
import { getRelayerKeys } from '../../src/agents/key-utils';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { readJSONAtPath } from '../../src/utils/utils';
import { assertEnvironment, getArgs, getCoreEnvironmentConfig } from '../utils';

const constMetricLabels = {
  // this needs to get set in main because of async reasons
  abacus_deployment: '',
  abacus_context: 'abacus',
};

const metricsRegister = new Registry();
const walletBalanceGauge = new Gauge({
  // Mirror the rust/ethers-prometheus `wallet_balance` gauge metric.
  name: 'abacus_wallet_balance',
  help: 'Current balance of eth and other tokens in the `tokens` map for the wallet addresses in the `wallets` set',
  registers: [metricsRegister],
  labelNames: [
    'chain',
    'wallet_address',
    'wallet_name',
    'token_address',
    'token_symbol',
    'token_name',
    ...(Object.keys(constMetricLabels) as (keyof typeof constMetricLabels)[]),
  ],
});
metricsRegister.registerMetric(walletBalanceGauge);

interface FunderBalance {
  chain: ChainName;
  address?: string;
  balance: number;
}

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
  constMetricLabels.abacus_deployment = environment;
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const relayerKeys = argv.f
    ? getRelayerKeysFromSerializedAddressFile(argv.f)
    : getRelayerKeys(config.agent);

  const chains = relayerKeys.map((key) => key.chainName!);
  const balances: FunderBalance[] = [];

  for (const chain of chains) {
    const chainConnection = multiProvider.getChainConnection(chain);

    const desiredBalance = desiredBalancePerChain[chain];
    const funderAddress = await chainConnection.getAddress();

    console.group({
      chain,
      funder: {
        address: funderAddress,
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
    balances.push({
      chain,
      address: funderAddress,
      balance: parseFloat(
        ethers.utils.formatEther(await chainConnection.signer!.getBalance()),
      ),
    });

    console.groupEnd();
    console.log('\n');
  }

  await submitFunderBalanceMetrics(balances);
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

function getPushGateway(): Pushgateway | null {
  const gatewayAddr = process.env['PROMETHEUS_PUSH_GATEWAY'];
  if (gatewayAddr) {
    // TODO: get actual push gateway address
    return new Pushgateway(gatewayAddr, [], metricsRegister);
  } else {
    console.warn(
      'Prometheus push gateway address was not defined; not publishing metrics.',
    );
    return null;
  }
}

function submitFunderBalanceMetrics(balances: FunderBalance[]) {
  const gateway = getPushGateway();
  if (!gateway) return;

  for (const { chain, address, balance } of balances) {
    walletBalanceGauge
      .labels({
        chain,
        wallet_address: address ?? 'unknown',
        wallet_name: 'relayer-funder',
        token_symbol: 'Native',
        token_name: 'Native',
        ...constMetricLabels,
      })
      .set(balance);
  }

  gateway
    .push({ jobName: 'relayer_funder' })
    .then(({ resp, body }) => {
      const statusCode =
        typeof resp == 'object' && resp != null && 'statusCode' in resp
          ? (resp as any).statusCode
          : 'unknown';
      console.debug(
        `Prometheus push resulted with status ${statusCode} and body ${body}`,
      );
    })
    .catch((err) => {
      console.error(`Error pushing metrics: ${err}`);
    });
}

main().catch(console.error);
