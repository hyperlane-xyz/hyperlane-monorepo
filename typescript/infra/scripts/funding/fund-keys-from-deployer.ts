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
import { getAllKeys } from '../../src/agents/key-utils';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { ContextAndRoles, ContextAndRolesMap } from '../../src/config/funding';
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

// Funds key addresses for multiple contexts from the deployer key of the context
// specified via the `--context` flag.
// The --contexts-and-roles flag is used to specify the contexts and the key roles
// for each context to fund.
// There are two ways to configure this script so that key addresses are known.
// You can pass in files using `-f`, which are expected to each be JSON arrays of objects
// of the form { identifier: '..', address: '..' }, where the keys described in one file
// are all for the same context. This will avoid requiring any sort of GCP/AWS credentials for
// fetching addresses from the keys themselves. A file for each context specified in --contexts-and-roles
// must be provided
// If the -f flag is not provided, addresses will be read directly from GCP/AWS for each
// context provided in --contexts-and-roles, which requires the appropriate credentials.
//
// Example usage:
//   ts-node ./scripts/funding/fund-keys-from-deployer.ts -e testnet2 --context abacus --contexts-and-roles abacus=relayer
async function main() {
  const argv = await getArgs()
    .string('f')
    .array('f')
    .alias('f', 'address-files')
    .describe(
      'f',
      'Files each containing JSON arrays of identifier and address objects for a single context. If not specified, key addresses are fetched from GCP/AWS and require sufficient credentials.',
    )
    .string('contexts-and-roles')
    .array('contexts-and-roles')
    .describe(
      'contexts-and-roles',
      'Array indicating contexts and the roles to fund for each context. Each element is expected as <context>=<role>,<role>,<role>...',
    )
    .coerce('contexts-and-roles', parseContextAndRolesMap)
    .demandOption('contexts-and-roles').argv;

  const environment = assertEnvironment(argv.e as string);
  constMetricLabels.abacus_deployment = environment;
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  let contextFunders: ContextFunder[];

  if (argv.f) {
    contextFunders = argv.f.map((path) =>
      ContextFunder.fromSerializedAddressFile(
        multiProvider,
        path,
        argv.contextsAndRoles,
      ),
    );
  } else {
    contextFunders = [];
    const contexts = Object.keys(argv.contextsAndRoles) as Contexts[];
    contextFunders = await Promise.all(
      contexts.map((context) =>
        ContextFunder.fromContext(
          multiProvider,
          context,
          argv.contextsAndRoles[context]!,
        ),
      ),
    );
  }

  let failureOccurred = false;
  for (const funder of contextFunders) {
    const failure = await funder.fund();
    if (failure) {
      failureOccurred = true;
    }
  }

  await submitMetrics(metricsRegister, 'key-funder');

  if (failureOccurred) {
    error('At least one failure occurred when funding');
    process.exit(1);
  }
}

// Funds keys for a single context
class ContextFunder {
  public readonly chains: ChainName[];

  constructor(
    public readonly multiProvider: MultiProvider<any>,
    public readonly keys: AgentKey[],
    public readonly context: Contexts,
    public readonly rolesToFund: KEY_ROLE_ENUM[],
  ) {
    const uniqueChains = new Set(
      keys.map((key) => key.chainName!).filter((chain) => chain !== undefined),
    );

    this.chains = Array.from(uniqueChains);
  }

  static fromSerializedAddressFile(
    multiProvider: MultiProvider<any>,
    path: string,
    contextsAndRolesToFund: ContextAndRolesMap,
  ) {
    log('Reading identifiers and addresses from file', {
      path,
    });
    const idsAndAddresses = readJSONAtPath(path);
    const keys: AgentKey[] = idsAndAddresses.map((idAndAddress: any) =>
      ReadOnlyAgentKey.fromSerializedAddress(
        idAndAddress.identifier,
        idAndAddress.address,
      ),
    );

    const context = keys[0].context;
    // Ensure all keys have the same context, just to be safe
    for (const key of keys) {
      if (key.context !== context) {
        throw Error(
          `Expected all keys at path ${path} to have context ${context}, found ${key.context}`,
        );
      }
    }

    const rolesToFund = contextsAndRolesToFund[context];
    if (!rolesToFund) {
      throw Error(
        `Expected context ${context} to be defined in contextsAndRolesToFund`,
      );
    }

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
      getAllKeys(agentConfig),
      context,
      rolesToFund,
    );
  }

  // Funds all the roles in this.rolesToFund
  // Returns whether a failure occurred.
  async fund(): Promise<boolean> {
    let failureOccurred = false;

    for (const role of this.rolesToFund) {
      const failure =
        role === KEY_ROLE_ENUM.Relayer
          ? await this.fundRelayersOnAllRequiredChains()
          : await this.fundNonRelayerKeysOnAllChains(role);
      if (failure) {
        failureOccurred = true;
      }
    }
    return failureOccurred;
  }

  // Returns whether a failure occurred.
  private async fundNonRelayerKeysOnAllChains(
    roleToFund: KEY_ROLE_ENUM,
  ): Promise<boolean> {
    let failureOccurred = false;

    const keys = this.getKeysWithRole(roleToFund);

    for (const chain of this.chains) {
      for (const key of keys) {
        const failure = await this.attemptToFundKey(key, chain);
        if (failure) {
          failureOccurred = true;
        }
      }
    }
    return failureOccurred;
  }

  // Funds the relayers on all the chains found in `this.chains`.
  // Does not fund a relayer key on its outbox chain.
  // Returns whether a failure occurred.
  private async fundRelayersOnAllRequiredChains(): Promise<boolean> {
    let failureOccurred = false;

    const keys = this.getKeysWithRole(KEY_ROLE_ENUM.Relayer);

    for (const chain of this.chains) {
      for (const key of keys.filter((k) => k.chainName !== chain)) {
        const failure = await this.attemptToFundKey(key, chain);
        if (failure) {
          failureOccurred = true;
        }
      }
    }
    return failureOccurred;
  }

  private async attemptToFundKey(
    key: AgentKey,
    chain: ChainName,
  ): Promise<boolean> {
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const desiredBalance = desiredBalancePerChain[chain];

    let failureOccurred = false;

    // Some types of keys must be fetched
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
    await this.updateWalletBalanceGauge(chainConnection, chain);

    return failureOccurred;
  }

  // Tops up the key's balance to the desired balance if the current balance
  // is lower than the desired balance by the min delta
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

    log('Assessing key for funding', {
      key: keyInfo,
      keyBalanceDelta: ethers.utils.formatEther(delta),
      minKeyBalanceDelta: ethers.utils.formatEther(minDelta),
      currentKeyBalance: ethers.utils.formatEther(currentBalance),
      desiredKeyBalance: desiredBalance,
      funder: {
        address: await chainConnection.getAddress(),
        balance: ethers.utils.formatEther(
          await chainConnection.signer!.getBalance(),
        ),
      },
      context: this.context,
      chain,
    });

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

  private getKeysWithRole(role: KEY_ROLE_ENUM) {
    return this.keys.filter((k) => k.role === role);
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

function parseContextAndRolesMap(strs: string[]): ContextAndRolesMap {
  const contextsAndRoles = strs.map(parseContextAndRoles);
  return contextsAndRoles.reduce(
    (prev, curr) => ({
      ...prev,
      [curr.context]: curr.roles,
    }),
    {},
  );
}

// Parses strings of the form <context>=<role>,<role>,<role>...
// e.g.:
//   abacus=relayer
//   flowcarbon=relayer,kathy
function parseContextAndRoles(str: string): ContextAndRoles {
  const [contextStr, rolesStr] = str.split('=');
  const context = assertContext(contextStr);

  const roles = rolesStr.split(',').map(assertRole);
  if (roles.length === 0) {
    throw Error('Expected > 0 roles');
  }

  // For now, restrict the valid roles we think are reasonable to want to fund
  const validRoles = new Set([KEY_ROLE_ENUM.Relayer, KEY_ROLE_ENUM.Kathy]);
  for (const role of roles) {
    if (!validRoles.has(role)) {
      throw Error(
        `Invalid role ${role}, must be one of ${Array.from(validRoles)}`,
      );
    }
  }

  return {
    context,
    roles,
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
