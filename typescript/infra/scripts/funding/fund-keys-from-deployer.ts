import { EthBridger, getL2Network } from '@arbitrum/sdk';
import { BigNumber, ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';
import { format } from 'util';

import {
  AgentConnectionType,
  AllChains,
  ChainName,
  Chains,
  HyperlaneIgp,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { ChainMap } from '@hyperlane-xyz/sdk/dist/types';
import { error, log, warn } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import { parseKeyIdentifier } from '../../src/agents/agent';
import { getAllCloudAgentKeys } from '../../src/agents/key-utils';
import {
  BaseCloudAgentKey,
  ReadOnlyCloudAgentKey,
} from '../../src/agents/keys';
import { DeployEnvironment } from '../../src/config';
import { deployEnvToSdkEnv } from '../../src/config/environment';
import { ContextAndRoles, ContextAndRolesMap } from '../../src/config/funding';
import { Role } from '../../src/roles';
import { submitMetrics } from '../../src/utils/metrics';
import {
  assertContext,
  assertRole,
  readJSONAtPath,
} from '../../src/utils/utils';
import { getAgentConfig, getArgs, getEnvironmentConfig } from '../utils';

type L2Chain =
  | Chains.optimism
  | Chains.optimismgoerli
  | Chains.arbitrum
  | Chains.arbitrumgoerli;

const L2Chains: ChainName[] = [
  Chains.optimism,
  Chains.optimismgoerli,
  Chains.arbitrum,
  Chains.arbitrumgoerli,
];

const L2ToL1: ChainMap<ChainName> = {
  optimismgoerli: 'goerli',
  arbitrumgoerli: 'goerli',
  optimism: 'ethereum',
  arbitrum: 'ethereum',
};

// Missing types declaration for bufio
const CrossChainMessenger = require('@eth-optimism/sdk').CrossChainMessenger; // eslint-disable-line

const constMetricLabels = {
  // this needs to get set in main because of async reasons
  hyperlane_deployment: '',
  hyperlane_context: 'hyperlane',
};

const metricsRegister = new Registry();

const walletBalanceGauge = new Gauge({
  // Mirror the rust/ethers-prometheus `wallet_balance` gauge metric.
  name: 'hyperlane_wallet_balance',
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

// Min delta is 50% of the desired balance
const MIN_DELTA_NUMERATOR = ethers.BigNumber.from(5);
const MIN_DELTA_DENOMINATOR = ethers.BigNumber.from(10);

// Don't send the full amount over to RC keys
const RC_FUNDING_DISCOUNT_NUMERATOR = ethers.BigNumber.from(2);
const RC_FUNDING_DISCOUNT_DENOMINATOR = ethers.BigNumber.from(10);

const desiredBalancePerChain: ChainMap<string> = {
  celo: '0.3',
  alfajores: '1',
  avalanche: '0.3',
  fuji: '1',
  ethereum: '0.5',
  polygon: '2',
  mumbai: '0.8',
  optimism: '0.5',
  arbitrum: '0.5',
  bsc: '0.05',
  bsctestnet: '1',
  goerli: '0.5',
  sepolia: '0.5',
  moonbasealpha: '1',
  moonbeam: '0.5',
  optimismgoerli: '0.5',
  arbitrumgoerli: '0.5',
  gnosis: '0.1',
  // unused
  test1: '0',
  test2: '0',
  test3: '0',
};

// Used to fund kathy with more tokens such that it's able to pay interchain gas
// on mainnet. The amount is roughly > $100
const desiredKathyBalancePerChain: ChainMap<string> = {
  celo: '150',
  avalanche: '6',
  polygon: '85',
  ethereum: '0.4',
  optimism: '0.1',
  arbitrum: '0.1',
  bsc: '0.35',
  moonbeam: '250',
  gnosis: '100',
};

// The balance threshold of the IGP contract that must be met for the key funder
// to call `claim()`
const igpClaimThresholdPerChain: ChainMap<string> = {
  celo: '5',
  alfajores: '1',
  avalanche: '2',
  fuji: '1',
  ethereum: '0.4',
  polygon: '20',
  mumbai: '1',
  optimism: '0.15',
  arbitrum: '0.1',
  bsc: '0.3',
  bsctestnet: '1',
  goerli: '1',
  sepolia: '1',
  moonbasealpha: '2',
  moonbeam: '5',
  optimismgoerli: '1',
  arbitrumgoerli: '1',
  gnosis: '5',
  // unused
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
//   ts-node ./scripts/funding/fund-keys-from-deployer.ts -e testnet3 --context hyperlane --contexts-and-roles rc=relayer
async function main() {
  const { environment, ...argv } = await getArgs()
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
    .demandOption('contexts-and-roles')

    .string('connection-type')
    .describe('connection-type', 'The provider connection type to use for RPCs')
    .default('connection-type', AgentConnectionType.Http)
    .choices('connection-type', [
      AgentConnectionType.Http,
      AgentConnectionType.HttpQuorum,
    ])
    .demandOption('connection-type')

    .boolean('skip-igp-claim')
    .describe('skip-igp-claim', 'If true, never claims funds from the IGP')
    .default('skip-igp-claim', false).argv;

  constMetricLabels.hyperlane_deployment = environment;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider(
    Contexts.Hyperlane, // Always fund from the hyperlane context
    Role.Deployer, // Always fund from the deployer
    argv.connectionType,
  );

  let contextFunders: ContextFunder[];

  if (argv.f) {
    contextFunders = argv.f.map((path) =>
      ContextFunder.fromSerializedAddressFile(
        environment,
        multiProvider,
        path,
        argv.contextsAndRoles,
        argv.skipIgpClaim,
      ),
    );
  } else {
    const contexts = Object.keys(argv.contextsAndRoles) as Contexts[];
    contextFunders = await Promise.all(
      contexts.map((context) =>
        ContextFunder.fromContext(
          environment,
          multiProvider,
          context,
          argv.contextsAndRoles[context]!,
          argv.skipIgpClaim,
        ),
      ),
    );
  }

  let failureOccurred = false;
  for (const funder of contextFunders) {
    failureOccurred ||= await funder.fund();
  }

  await submitMetrics(metricsRegister, 'key-funder');

  if (failureOccurred) {
    error('At least one failure occurred when funding');
    process.exit(1);
  }
}

// Funds keys for a single context
class ContextFunder {
  igp: HyperlaneIgp;

  constructor(
    public readonly environment: DeployEnvironment,
    public readonly multiProvider: MultiProvider,
    public readonly keys: BaseCloudAgentKey[],
    public readonly context: Contexts,
    public readonly rolesToFund: Role[],
    public readonly skipIgpClaim: boolean,
  ) {
    this.igp = HyperlaneIgp.fromEnvironment(
      deployEnvToSdkEnv[this.environment],
      multiProvider,
    );
  }

  static fromSerializedAddressFile(
    environment: DeployEnvironment,
    multiProvider: MultiProvider,
    path: string,
    contextsAndRolesToFund: ContextAndRolesMap,
    skipIgpClaim: boolean,
  ) {
    log('Reading identifiers and addresses from file', {
      path,
    });
    const idsAndAddresses = readJSONAtPath(path);
    const keys: BaseCloudAgentKey[] = idsAndAddresses
      .filter((idAndAddress: any) => {
        const parsed = parseKeyIdentifier(idAndAddress.identifier);
        // Filter out any invalid chain names. This can happen if we're running an old
        // version of this script but the list of identifiers (expected to be stored in GCP secrets)
        // references newer chains.
        return (
          parsed.chainName === undefined ||
          (AllChains as string[]).includes(parsed.chainName)
        );
      })
      .map((idAndAddress: any) =>
        ReadOnlyCloudAgentKey.fromSerializedAddress(
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

    return new ContextFunder(
      environment,
      multiProvider,
      keys,
      context,
      rolesToFund,
      skipIgpClaim,
    );
  }

  // The keys here are not ReadOnlyCloudAgentKeys, instead they are AgentGCPKey or AgentAWSKeys,
  // which require credentials to fetch. If you want to avoid requiring credentials, use
  // fromSerializedAddressFile instead.
  static async fromContext(
    environment: DeployEnvironment,
    multiProvider: MultiProvider,
    context: Contexts,
    rolesToFund: Role[],
    skipIgpClaim: boolean,
  ) {
    const agentConfig = getAgentConfig(context, environment);
    const keys = getAllCloudAgentKeys(agentConfig);
    await Promise.all(keys.map((key) => key.fetch()));
    return new ContextFunder(
      environment,
      multiProvider,
      keys,
      context,
      rolesToFund,
      skipIgpClaim,
    );
  }

  // Funds all the roles in this.rolesToFund
  // Returns whether a failure occurred.
  async fund(): Promise<boolean> {
    let failureOccurred = false;

    const chainKeys = this.getChainKeys();
    const promises = Object.entries(chainKeys).map(async ([chain, keys]) => {
      if (keys.length > 0) {
        if (!this.skipIgpClaim) {
          failureOccurred ||= await gracefullyHandleError(
            () => this.attemptToClaimFromIgp(chain),
            chain,
            'Error claiming from IGP',
          );
        }

        failureOccurred ||= await gracefullyHandleError(
          () => this.bridgeIfL2(chain),
          chain,
          'Error bridging to L2',
        );
      }
      for (const key of keys) {
        const failure = await this.attemptToFundKey(key, chain);
        failureOccurred ||= failure;
      }
    });

    try {
      await Promise.all(promises);
    } catch (e) {
      error('Unhandled error when funding key', { error: format(e) });
      failureOccurred = true;
    }

    return failureOccurred;
  }

  private getChainKeys() {
    const chainKeys: ChainMap<BaseCloudAgentKey[]> = Object.fromEntries(
      // init with empty arrays
      AllChains.map((c) => [c, []]),
    );
    for (const role of this.rolesToFund) {
      const keys = this.getKeysWithRole(role);
      for (const key of keys) {
        const chains = getAgentConfig(
          key.context,
          key.environment,
        ).contextChainNames;
        for (const chain of chains) {
          chainKeys[chain].push(key);
        }
      }
    }
    return chainKeys;
  }

  private async attemptToFundKey(
    key: BaseCloudAgentKey,
    chain: ChainName,
  ): Promise<boolean> {
    const provider = this.multiProvider.tryGetProvider(chain);
    if (!provider) {
      error('Cannot get chain connection', {
        chain,
      });
      // Consider this an error, but don't throw and prevent all future funding attempts
      return true;
    }
    const desiredBalance = this.getDesiredBalanceForRole(chain, key.role);

    let failureOccurred = false;

    try {
      await this.fundKeyIfRequired(chain, key, desiredBalance);
    } catch (err) {
      error('Error funding key', {
        key: await getKeyInfo(
          key,
          chain,
          this.multiProvider.getProvider(chain),
        ),
        context: this.context,
        error: err,
      });
      failureOccurred = true;
    }
    await this.updateWalletBalanceGauge(chain);

    return failureOccurred;
  }

  private async bridgeIfL2(chain: ChainName) {
    if (L2Chains.includes(chain)) {
      const funderAddress = await this.multiProvider.getSignerAddress(chain)!;
      const desiredBalanceEther = ethers.utils.parseUnits(
        desiredBalancePerChain[chain],
        'ether',
      );
      // Optionally bridge ETH to L2 before funding the desired key.
      // By bridging the funder with 10x the desired balance we save
      // on L1 gas.
      const bridgeAmount = await this.getFundingAmount(
        chain,
        funderAddress,
        desiredBalanceEther.mul(5),
      );
      if (bridgeAmount.gt(0)) {
        await this.bridgeToL2(chain as L2Chain, funderAddress, bridgeAmount);
      }
    }
  }

  private async attemptToClaimFromIgp(chain: ChainName) {
    const igpClaimThresholdEther = igpClaimThresholdPerChain[chain];
    if (!igpClaimThresholdEther) {
      warn(`No IGP claim threshold for chain ${chain}`);
      return;
    }
    const igpClaimThreshold = ethers.utils.parseEther(igpClaimThresholdEther);

    const provider = this.multiProvider.getProvider(chain);
    const igp = this.igp.getContracts(chain).interchainGasPaymaster;
    const igpBalance = await provider.getBalance(igp.address);

    log('Checking IGP balance', {
      chain,
      igpBalance: ethers.utils.formatEther(igpBalance),
      igpClaimThreshold: ethers.utils.formatEther(igpClaimThreshold),
    });

    if (igpBalance.gt(igpClaimThreshold)) {
      log('IGP balance exceeds claim threshold, claiming', {
        chain,
      });
      await this.multiProvider.sendTransaction(
        chain,
        await igp.populateTransaction.claim(),
      );
    } else {
      log('IGP balance does not exceed claim threshold, skipping', {
        chain,
      });
    }
  }

  private async getFundingAmount(
    chain: ChainName,
    address: string,
    desiredBalance: BigNumber,
  ): Promise<BigNumber> {
    const currentBalance = await this.multiProvider
      .getProvider(chain)
      .getBalance(address);
    const delta = desiredBalance.sub(currentBalance);
    const minDelta = desiredBalance
      .mul(MIN_DELTA_NUMERATOR)
      .div(MIN_DELTA_DENOMINATOR);
    return delta.gt(minDelta) ? delta : BigNumber.from(0);
  }

  private getDesiredBalanceForRole(chain: ChainName, role: Role): BigNumber {
    const desiredBalanceEther =
      role === Role.Kathy && desiredKathyBalancePerChain[chain]
        ? desiredKathyBalancePerChain[chain]
        : desiredBalancePerChain[chain];
    let desiredBalance = ethers.utils.parseEther(desiredBalanceEther);
    if (this.context === Contexts.ReleaseCandidate) {
      desiredBalance = desiredBalance
        .mul(RC_FUNDING_DISCOUNT_NUMERATOR)
        .div(RC_FUNDING_DISCOUNT_DENOMINATOR);
    }
    return desiredBalance;
  }

  // Tops up the key's balance to the desired balance if the current balance
  // is lower than the desired balance by the min delta
  private async fundKeyIfRequired(
    chain: ChainName,
    key: BaseCloudAgentKey,
    desiredBalance: BigNumber,
  ) {
    const fundingAmount = await this.getFundingAmount(
      chain,
      key.address,
      desiredBalance,
    );
    const keyInfo = await getKeyInfo(
      key,
      chain,
      this.multiProvider.getProvider(chain),
    );
    const funderAddress = await this.multiProvider.getSignerAddress(chain);

    if (fundingAmount.eq(0)) {
      log('Skipping funding for key', {
        key: keyInfo,
        context: this.context,
        chain,
      });
      return;
    } else {
      log('Funding key', {
        chain,
        amount: ethers.utils.formatEther(fundingAmount),
        key: keyInfo,
        funder: {
          address: funderAddress,
          balance: ethers.utils.formatEther(
            await this.multiProvider.getSigner(chain).getBalance(),
          ),
        },
        context: this.context,
      });
    }

    const tx = await this.multiProvider.sendTransaction(chain, {
      to: key.address,
      value: fundingAmount,
    });
    log('Sent transaction', {
      key: keyInfo,
      txUrl: this.multiProvider.tryGetExplorerTxUrl(chain, {
        hash: tx.transactionHash,
      }),
      context: this.context,
      chain,
    });
    log('Got transaction receipt', {
      key: keyInfo,
      tx,
      context: this.context,
      chain,
    });
  }

  private async bridgeToL2(l2Chain: L2Chain, to: string, amount: BigNumber) {
    const l1Chain = L2ToL1[l2Chain];
    log('Bridging ETH to L2', {
      amount: ethers.utils.formatEther(amount),
      l1Funder: await getAddressInfo(
        await this.multiProvider.getSignerAddress(l1Chain),
        l1Chain,
        this.multiProvider.getProvider(l1Chain),
      ),
      l2Funder: await getAddressInfo(
        to,
        l2Chain,
        this.multiProvider.getProvider(l2Chain),
      ),
    });
    let tx;
    if (l2Chain.includes('optimism')) {
      tx = await this.bridgeToOptimism(l2Chain, amount, to);
    } else if (l2Chain.includes('arbitrum')) {
      tx = await this.bridgeToArbitrum(l2Chain, amount);
    } else {
      throw new Error(`${l2Chain} is not an L2`);
    }
    await this.multiProvider.handleTx(l1Chain, tx);
  }

  private async bridgeToOptimism(
    l2Chain: L2Chain,
    amount: BigNumber,
    to: string,
  ) {
    const l1Chain = L2ToL1[l2Chain];
    const crossChainMessenger = new CrossChainMessenger({
      l1ChainId: this.multiProvider.getDomainId(l1Chain),
      l2ChainId: this.multiProvider.getDomainId(l2Chain),
      l1SignerOrProvider: this.multiProvider.getSignerOrProvider(l1Chain),
      l2SignerOrProvider: this.multiProvider.getSignerOrProvider(l2Chain),
    });
    return crossChainMessenger.depositETH(amount, {
      recipient: to,
      overrides: this.multiProvider.getTransactionOverrides(l1Chain),
    });
  }

  private async bridgeToArbitrum(l2Chain: L2Chain, amount: BigNumber) {
    const l1Chain = L2ToL1[l2Chain];
    const l2Network = await getL2Network(
      this.multiProvider.getDomainId(l2Chain),
    );
    const ethBridger = new EthBridger(l2Network);
    return ethBridger.deposit({
      amount,
      l1Signer: this.multiProvider.getSigner(l1Chain),
      overrides: this.multiProvider.getTransactionOverrides(l1Chain),
    });
  }

  private async updateWalletBalanceGauge(chain: ChainName) {
    const funderAddress = await this.multiProvider.getSignerAddress(chain);
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
          ethers.utils.formatEther(
            await this.multiProvider.getSigner(chain).getBalance(),
          ),
        ),
      );
  }

  private getKeysWithRole(role: Role) {
    return this.keys.filter((k) => k.role === role);
  }
}

async function getAddressInfo(
  address: string,
  chain: ChainName,
  provider: ethers.providers.Provider,
) {
  return {
    chain,
    balance: ethers.utils.formatEther(await provider.getBalance(address)),
    address,
  };
}

async function getKeyInfo(
  key: BaseCloudAgentKey,
  chain: ChainName,
  provider: ethers.providers.Provider,
) {
  return {
    ...(await getAddressInfo(key.address, chain, provider)),
    context: key.context,
    originChain: key.chainName,
    role: key.role,
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
//   hyperlane=relayer
//   flowcarbon=relayer,kathy
function parseContextAndRoles(str: string): ContextAndRoles {
  const [contextStr, rolesStr] = str.split('=');
  const context = assertContext(contextStr);

  const roles = rolesStr.split(',').map(assertRole);
  if (roles.length === 0) {
    throw Error('Expected > 0 roles');
  }

  // For now, restrict the valid roles we think are reasonable to want to fund
  const validRoles = new Set([Role.Relayer, Role.Kathy]);
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

// Returns whether an error occurred
async function gracefullyHandleError(
  fn: () => Promise<void>,
  chain: ChainName,
  errorMessage: string,
): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    error(errorMessage, {
      chain,
      error: format(err),
    });
  }
  return true;
}

main().catch((err) => {
  error('Error occurred in main', {
    // JSON.stringifying an Error returns '{}'.
    // This is a workaround from https://stackoverflow.com/a/60370781
    error: format(err),
  });
  process.exit(1);
});
