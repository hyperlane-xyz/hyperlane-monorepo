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

  const relayerInfo = relayerKeyInfo(relayer);

  if (delta.gt(minDelta)) {
    log('Sending relayer funds...', {
      relayer: relayerInfo,
      amount: ethers.utils.formatEther(delta),
    });
    const tx = await chainConnection.signer!.sendTransaction({
      to: relayer.address,
      value: delta,
      ...chainConnection.overrides,
    });
    log('Sent transaction', {
      relayer: relayerInfo,
      txUrl: chainConnection.getTxUrl(tx),
    });
    const receipt = await tx.wait(chainConnection.confirmations);
    log('Got transaction receipt', {
      relayer: relayerInfo,
      receipt,
    });
  }

  log('Relayer balance', {
    relayer: relayerInfo,
    balance: ethers.utils.formatEther(
      await chainConnection.provider.getBalance(relayer.address),
    ),
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

  let failureOccurred = false;

  for (const chain of chains) {
    const chainConnection = multiProvider.getChainConnection(chain);

    const desiredBalance = desiredBalancePerChain[chain];
    const funderAddress = await chainConnection.getAddress();

    log('Funding relayers on chain...', {
      chain,
      funder: {
        address: funderAddress,
        balance: ethers.utils.formatEther(
          await chainConnection.signer!.getBalance(),
        ),
        desiredRelayerBalance: desiredBalance,
      },
    });

    for (const relayerKey of relayerKeys.filter(
      (key) => key.chainName !== chain,
    )) {
      await relayerKey.fetch();
      try {
        await fundRelayer(chainConnection, relayerKey, desiredBalance);
      } catch (err) {
        error('Error funding relayer', {
          relayer: relayerKeyInfo(relayerKey),
          error: err,
        });
        failureOccurred = true;
      }
    }
    balances.push({
      chain,
      address: funderAddress,
      balance: parseFloat(
        ethers.utils.formatEther(await chainConnection.signer!.getBalance()),
      ),
    });
  }

  await submitFunderBalanceMetrics(balances);

  if (failureOccurred) {
    error('At least one failure occurred when funding relayers');
    process.exit(1);
  }
}

function getRelayerKeysFromSerializedAddressFile(path: string): AgentKey[] {
  log('Reading keys from file', {
    path,
  });
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
    return new Pushgateway(gatewayAddr, [], metricsRegister);
  } else {
    warn(
      'Prometheus push gateway address was not defined; not publishing metrics.',
    );
    return null;
  }
}

async function submitFunderBalanceMetrics(balances: FunderBalance[]) {
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

  const { resp, body } = await gateway.push({ jobName: 'relayer_funder' });
  const statusCode =
    typeof resp == 'object' && resp != null && 'statusCode' in resp
      ? (resp as any).statusCode
      : 'unknown';
  log(`Prometheus metrics pushed to PushGateway`, {
    statusCode,
    body,
  });
}

function log(message: string, data?: any) {
  logWithFunction(console.log, message, data);
}

function warn(message: string, data?: any) {
  logWithFunction(console.warn, message, data);
}

function error(message: string, data?: any) {
  logWithFunction(console.error, message, data);
}

function logWithFunction(
  logFn: (...contents: any[]) => void,
  message: string,
  data?: any,
) {
  const fullLog = {
    ...data,
    message,
  };
  logFn(JSON.stringify(fullLog));
}

function relayerKeyInfo(relayerKey: AgentKey) {
  return {
    address: relayerKey.address,
    identifier: relayerKey.identifier,
    chain: relayerKey.chainName,
  };
}

main().catch((err) => {
  error('Error occurred in main', {
    error: err,
  });
  process.exit(1);
});
