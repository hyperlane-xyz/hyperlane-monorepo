import { Console } from 'console';
import { ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';
import { format } from 'util';

import {
  ChainConnection,
  ChainName,
  CompleteChainMap,
  MultiProvider,
} from '@abacus-network/sdk';

import { Contexts } from '../../config/contexts';
import { AgentKey, ReadOnlyAgentKey } from '../../src/agents/agent';
import { getRelayerKeys } from '../../src/agents/key-utils';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { submitMetrics } from '../../src/utils/metrics';
import { assertContext, readJSONAtPath } from '../../src/utils/utils';
import {
  assertEnvironment,
  getAgentConfig,
  getArgs,
  getCoreEnvironmentConfig,
} from '../utils';

const constMetricLabels = {
  // this needs to get set in main because of async reasons
  abacus_deployment: '',
  abacus_context: 'abacus',
};

const metricsRegister = new Registry();

type WalletBalanceGauge = Gauge<
  | 'chain'
  | 'wallet_address'
  | 'wallet_name'
  | 'token_address'
  | 'token_symbol'
  | 'token_name'
  | 'abacus_deployment'
  | 'abacus_context'
>;
const walletBalanceGauge: WalletBalanceGauge = new Gauge({
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

async function main() {
  const argv = await getArgs()
    .string('f')
    .array('f')
    .alias('f', 'address-files')
    .describe(
      'f',
      'Files each containing JSON arrays of identifier and address objects',
    )
    .string('contexts-to-fund')
    .array('contexts-to-fund')
    .describe('contexts-to-fund', 'Contexts to fund relayers for')
    .coerce('contexts-to-fund', (contexts: string[]) => {
      return contexts.map(assertContext);
    })
    .conflicts('f', 'contexts-to-fund').argv;

  const environment = assertEnvironment(argv.e as string);
  constMetricLabels.abacus_deployment = environment;
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const contextRelayerFunders = argv.f
    ? argv.f.map((path) =>
        ContextRelayerFunder.fromSerializedAddressFile(multiProvider, path),
      )
    : argv.contextsToFund!.map((context) =>
        ContextRelayerFunder.fromSerializedAddressFile(multiProvider, context),
      );

  let failureOccurred = false;
  for (const relayerFunder of contextRelayerFunders) {
    const failure = await relayerFunder.fundRelayersOnAllChains();
    if (failure) {
      failureOccurred = true;
    }
  }

  await submitMetrics(metricsRegister, 'relayer-funder');

  if (failureOccurred) {
    error('At least one failure occurred when funding relayers');
    process.exit(1);
  }
}

// Funds relayers for a single context
class ContextRelayerFunder {
  public readonly chains: ChainName[];

  constructor(
    public readonly multiProvider: MultiProvider<any>,
    public readonly keys: AgentKey[],
    public readonly context: Contexts,
  ) {
    this.chains = keys.map((key) => key.chainName!);
  }

  static fromSerializedAddressFile(
    multiProvider: MultiProvider<any>,
    path: string,
  ) {
    log('Reading identifiers and addresses from file', {
      path,
    });
    const idsAndAddresses = readJSONAtPath(path);
    const keys: AgentKey[] = idsAndAddresses
      .map((idAndAddress: any) =>
        ReadOnlyAgentKey.fromSerializedAddress(
          idAndAddress.identifier,
          idAndAddress.address,
        ),
      )
      .filter((key: AgentKey) => key.role === KEY_ROLE_ENUM.Relayer);

    const context = keys[0].context;
    // Ensure all keys have the same context, just to be safe
    keys.forEach((key) => {
      if (key.context !== context) {
        throw Error(
          `Expected all keys at path ${path} to have context ${context}, found ${key.context}`,
        );
      }
    });

    log('Read keys for context from file', {
      path,
      keyCount: keys.length,
      context,
    });

    return new ContextRelayerFunder(multiProvider, keys, context);
  }

  // The keys here are not ReadOnlyAgentKeys, instead they are AgentGCPKey or AgentAWSKeys,
  // which require credentials to fetch. If you want to avoid requiring credentials, use
  // fromSerializedAddressFile instead.
  static async fromContext(
    multiProvider: MultiProvider<any>,
    context: Contexts,
  ) {
    const agentConfig = await getAgentConfig(context);
    return new ContextRelayerFunder(
      multiProvider,
      getRelayerKeys(agentConfig),
      context,
    );
  }

  // Funds the relayers on all the chains found in `this.chains`
  async fundRelayersOnAllChains() {
    let failureOccurred = false;

    for (const chain of this.chains) {
      const chainConnection = this.multiProvider.getChainConnection(chain);

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
        context: this.context,
      });

      for (const key of this.keys.filter((k) => k.chainName !== chain)) {
        await key.fetch();
        try {
          await this.fundRelayerIfRequired(
            chainConnection,
            key,
            desiredBalance,
          );
        } catch (err) {
          error('Error funding relayer', {
            relayer: relayerKeyInfo(key),
            context: this.context,
            error: err,
          });
          failureOccurred = true;
        }
      }

      walletBalanceGauge
        .labels({
          chain,
          wallet_address: funderAddress ?? 'unknown',
          wallet_name: 'relayer-funder',
          token_symbol: 'Native',
          token_name: 'Native',
          ...constMetricLabels,
        })
        .set(
          parseFloat(
            ethers.utils.formatEther(
              await chainConnection.signer!.getBalance(),
            ),
          ),
        );
    }
    return failureOccurred;
  }

  private async fundRelayerIfRequired(
    chainConnection: ChainConnection,
    key: AgentKey,
    desiredBalance: string,
  ) {
    const currentBalance = await chainConnection.provider.getBalance(
      key.address,
    );
    const desiredBalanceEther = ethers.utils.parseUnits(
      desiredBalance,
      'ether',
    );
    const delta = desiredBalanceEther.sub(currentBalance);

    const minDelta = desiredBalanceEther
      .mul(MIN_DELTA_NUMERATOR)
      .div(MIN_DELTA_DENOMINATOR);

    const relayerInfo = relayerKeyInfo(key);

    if (delta.gt(minDelta)) {
      log('Sending relayer funds...', {
        relayer: relayerInfo,
        amount: ethers.utils.formatEther(delta),
        context: this.context,
      });

      console.log('jk no');
      return;

      const tx = await chainConnection.signer!.sendTransaction({
        to: key.address,
        value: delta,
        ...chainConnection.overrides,
      });
      log('Sent transaction', {
        relayer: relayerInfo,
        txUrl: chainConnection.getTxUrl(tx),
        context: this.context,
      });
      const receipt = await tx.wait(chainConnection.confirmations);
      log('Got transaction receipt', {
        relayer: relayerInfo,
        receipt,
        context: this.context,
      });
    }
  }
}

function log(message: string, data?: any) {
  logWithFunction(console.log, message, data);
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
    context: relayerKey.context,
    address: relayerKey.address,
    identifier: relayerKey.identifier,
    originChain: relayerKey.chainName,
  };
}

main().catch((err) => {
  error('Error occurred in main', {
    // JSON.stringifying an Error returns '{}'.
    // This is a workaround from https://stackoverflow.com/a/60370781
    error: format(err),
  });
  process.exit(1);
});
