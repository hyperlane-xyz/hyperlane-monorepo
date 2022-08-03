import { ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';
import { format } from 'util';

import {
  ChainConnection,
  ChainName,
  CompleteChainMap,
  MultiProvider,
} from '@abacus-network/sdk';
import { error, log } from '@abacus-network/utils';

import { Contexts } from '../../config/contexts';
import { AgentKey, ReadOnlyAgentKey } from '../../src/agents/agent';
import { getKey, getRelayerKeys } from '../../src/agents/key-utils';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { submitMetrics } from '../../src/utils/metrics';
import {
  assertContext,
  assertRole,
  readJSONAtPath,
} from '../../src/utils/utils';
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

// Min delta is 1/10 of the desired balance
const MIN_DELTA_NUMERATOR = ethers.BigNumber.from(1);
const MIN_DELTA_DENOMINATOR = ethers.BigNumber.from(10);

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

// Funds relayer addresses for multiple contexts from the deployer key of the context
// specified via the `--context` flag.
// There are two ways to configure this script so that relayer addresses are known.
// You can pass in files using `-f`, which are expected to each be JSON arrays of objects
// of the form { identifier: '..', address: '..' }, where the keys described in one file
// are all for the same context. This will avoid requiring any sort of GCP/AWS credentials for
// fetching addresses from the keys themselves.
// Alternatively, using `--contexts-to-fund` will fetch relayer addresses from GCP/AWS, which
// requires credentials.
async function main() {
  const argv = await getArgs()
    .string('f')
    .array('f')
    .alias('f', 'address-files')
    .describe(
      'f',
      'Files each containing JSON arrays of identifier and address objects for a context',
    )
    .string('contexts-to-fund')
    .array('contexts-to-fund')
    .describe(
      'contexts-to-fund',
      'Contexts to fund relayers for. If specified, relayer addresses are fetched from GCP/AWS and require sufficient credentials.',
    )
    .coerce('contexts-to-fund', (contexts: string[]) => {
      return contexts.map(assertContext);
    })
    // Only one of the two methods for getting relayer addresses
    .conflicts('f', 'contexts-to-fund')
    .string('roles-to-fund')
    .array('roles-to-fund')
    .describe(
      'roles-to-fund',
      'The roles to fund for every context. Note this is not context-specific.',
    )
    .coerce('roles-to-fund', (roles: string[]) => {
      return roles.map(assertRole);
    })
    .demandOption('roles-to-fund').argv;

  const environment = assertEnvironment(argv.e as string);
  constMetricLabels.abacus_deployment = environment;
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const contextRelayerFunders = argv.f
    ? argv.f.map((path) =>
        ContextFunder.fromSerializedAddressFile(
          multiProvider,
          path,
          argv.rolesToFund,
        ),
      )
    : argv.contextsToFund!.map((context) =>
        ContextFunder.fromSerializedAddressFile(
          multiProvider,
          context,
          argv.rolesToFund,
        ),
      );

  let failureOccurred = false;
  for (const relayerFunder of contextRelayerFunders) {
    const failure = await relayerFunder.fundRolesOnAllChains();
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
class ContextFunder {
  public readonly chains: ChainName[];

  constructor(
    public readonly multiProvider: MultiProvider<any>,
    public readonly keys: AgentKey[],
    public readonly context: Contexts,
    public readonly rolesToFund: KEY_ROLE_ENUM[],
  ) {
    this.chains = keys.map((key) => key.chainName!);
  }

  static fromSerializedAddressFile(
    multiProvider: MultiProvider<any>,
    path: string,
    rolesToFund: KEY_ROLE_ENUM[],
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

    return new ContextFunder(multiProvider, keys, context, rolesToFund);
  }

  // The keys here are not ReadOnlyAgentKeys, instead they are AgentGCPKey or AgentAWSKeys,
  // which require credentials to fetch. If you want to avoid requiring credentials, use
  // fromSerializedAddressFile instead.
  static async fromContext(
    multiProvider: MultiProvider<any>,
    context: Contexts,
    rolesToFund: KEY_ROLE_ENUM[],
  ) {
    const agentConfig = await getAgentConfig(context);
    return new ContextFunder(
      multiProvider,
      getRelayerKeys(agentConfig),
      context,
      rolesToFund,
    );
  }

  // Returns whether a failure occurred.
  async fundRolesOnAllChains(): Promise<boolean> {
    let failureOccurred = false;

    for (const role of this.rolesToFund) {
      const failure =
        role === KEY_ROLE_ENUM.Relayer
          ? await this.fundRelayersOnAllChains()
          : await this.fundRoleOnAllChains();
      if (failure) {
        failureOccurred = true;
      }
    }
    return failureOccurred;
  }

  // Returns whether a failure occurred.
  private async fundRoleOnAllChains(): Promise<boolean> {
    for (const chain of this.chains) {
      const chainConnection = this.multiProvider.getChainConnection(chain);
    }
  }

  // Funds the relayers on all the chains found in `this.chains`.
  // Returns whether a failure occurred.
  private async fundRelayersOnAllChains(): Promise<boolean> {
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
        await this.fundKey(key, chain);
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

  private async fundKey(key: AgentKey, chain: ChainName) {
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const desiredBalance = desiredBalancePerChain[chain];

    let failureOccurred = false;

    await key.fetch();
    try {
      await this.fundKeyIfRequired(chainConnection, chain, key, desiredBalance);
    } catch (err) {
      error('Error funding key', {
        key: getKeyInfo(key),
        context: this.context,
        error: err,
      });
      failureOccurred = true;
    }
    await this.updateWalletBalanceGauge();

    return failureOccurred;
  }

  private async updateWalletBalanceGauge(
    chainConnection: ChainConnection,
    chain: ChainName,
  ) {
    const funderAddress = await chainConnection.getAddress();
    walletBalanceGauge
      .labels({
        chain,
        wallet_address: funderAddress ?? 'unknown',
        wallet_name: 'key-funder',
        token_symbol: 'Native',
        token_name: 'Native',
        ...constMetricLabels,
      })
      .set(
        parseFloat(
          ethers.utils.formatEther(await chainConnection.signer!.getBalance()),
        ),
      );
  }

  private async fundKeyIfRequired(
    chainConnection: ChainConnection,
    chain: ChainName,
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

    const keyInfo = getKeyInfo(key);

    if (delta.gt(minDelta)) {
      log('Sending funds...', {
        key: keyInfo,
        amount: ethers.utils.formatEther(delta),
        context: this.context,
        chain,
      });

      const tx = await chainConnection.signer!.sendTransaction({
        to: key.address,
        value: delta,
        ...chainConnection.overrides,
      });
      log('Sent transaction', {
        key: keyInfo,
        txUrl: chainConnection.getTxUrl(tx),
        context: this.context,
        chain,
      });
      const receipt = await tx.wait(chainConnection.confirmations);
      log('Got transaction receipt', {
        key: keyInfo,
        receipt,
        context: this.context,
        chain,
      });
    }
  }
}

function getKeyInfo(key: AgentKey) {
  return {
    context: key.context,
    address: key.address,
    identifier: key.identifier,
    originChain: key.chainName,
    role: key.role,
    index: key.index,
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
