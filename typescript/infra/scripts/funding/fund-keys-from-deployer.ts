import { EthBridger, getL2Network } from '@arbitrum/sdk';
import { CrossChainMessenger } from '@eth-optimism/sdk';
import { BigNumber, ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';
import { format } from 'util';

import {
  ChainMap,
  ChainName,
  Chains,
  HyperlaneIgp,
  MultiProvider,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMap, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import {
  KeyAsAddress,
  fetchLocalKeyAddresses,
  getRoleKeysPerChain,
} from '../../src/agents/key-utils.js';
import {
  BaseAgentKey,
  LocalAgentKey,
  ReadOnlyCloudAgentKey,
} from '../../src/agents/keys.js';
import {
  DeployEnvironment,
  deployEnvToSdkEnv,
} from '../../src/config/environment.js';
import {
  ContextAndRoles,
  ContextAndRolesMap,
  KeyFunderConfig,
} from '../../src/config/funding.js';
import { FundableRole, Role } from '../../src/roles.js';
import { submitMetrics } from '../../src/utils/metrics.js';
import {
  assertContext,
  assertFundableRole,
  assertRole,
  isEthereumProtocolChain,
  readJSONAtPath,
} from '../../src/utils/utils.js';
import { getAgentConfig, getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

import L1ETHGateway from './utils/L1ETHGateway.json';
import L1MessageQueue from './utils/L1MessageQueue.json';
import L1ScrollMessenger from './utils/L1ScrollMessenger.json';

const logger = rootLogger.child({ module: 'fund-keys' });

const nativeBridges = {
  scrollsepolia: {
    l1ETHGateway: '0x8A54A2347Da2562917304141ab67324615e9866d',
    l1Messenger: '0x50c7d3e7f7c656493D1D76aaa1a836CedfCBB16A',
  },
};

type L2Chain = Chains.optimism | Chains.arbitrum | Chains.base;

const L2Chains: ChainName[] = [Chains.optimism, Chains.arbitrum, Chains.base];

const L2ToL1: ChainMap<ChainName> = {
  optimism: 'ethereum',
  arbitrum: 'ethereum',
  base: 'ethereum',
};

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

// The balance threshold of the IGP contract that must be met for the key funder
// to call `claim()`
const igpClaimThresholdPerChain: ChainMap<string> = {
  celo: '5',
  alfajores: '1',
  avalanche: '2',
  fuji: '1',
  ethereum: '0.4',
  polygon: '20',
  optimism: '0.15',
  arbitrum: '0.1',
  bsc: '0.3',
  bsctestnet: '1',
  sepolia: '1',
  moonbeam: '5',
  gnosis: '5',
  scrollsepolia: '0.1',
  base: '0.1',
  scroll: '0.1',
  polygonzkevm: '0.1',
  plumetestnet: '0.1',
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
//   tsx ./scripts/funding/fund-keys-from-deployer.ts -e testnet4 --context hyperlane --contexts-and-roles rc=relayer
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

    .string('desired-balance-per-chain')
    .array('desired-balance-per-chain')
    .describe(
      'desired-balance-per-chain',
      'Array indicating target balance to fund for each chain. Each element is expected as <chainName>=<balance>',
    )
    .coerce('desired-balance-per-chain', parseBalancePerChain)
    .demandOption('desired-balance-per-chain')

    .string('desired-kathy-balance-per-chain')
    .array('desired-kathy-balance-per-chain')
    .describe(
      'desired-kathy-balance-per-chain',
      'Array indicating target balance to fund Kathy for each chain. Each element is expected as <chainName>=<balance>',
    )
    .coerce('desired-kathy-balance-per-chain', parseBalancePerChain)

    .string('connection-type')
    .describe('connection-type', 'The provider connection type to use for RPCs')
    .default('connection-type', RpcConsensusType.Single)
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
        argv.contextsAndRoles,
        argv.skipIgpClaim,
        argv.desiredBalancePerChain,
        argv.desiredKathyBalancePerChain ?? {},
        path,
      ),
    );
  } else {
    const contexts = Object.keys(argv.contextsAndRoles) as Contexts[];
    contextFunders = await Promise.all(
      contexts.map((context) =>
        ContextFunder.fromLocal(
          environment,
          multiProvider,
          context,
          argv.contextsAndRoles[context]!,
          argv.skipIgpClaim,
          argv.desiredBalancePerChain,
          argv.desiredKathyBalancePerChain ?? {},
        ),
      ),
    );
  }

  let failureOccurred = false;
  for (const funder of contextFunders) {
    failureOccurred ||= await funder.fund();
  }

  await submitMetrics(metricsRegister, `key-funder-${environment}`);

  if (failureOccurred) {
    logger.error('At least one failure occurred when funding');
    process.exit(1);
  }
}

// Funds keys for a single context
class ContextFunder {
  igp: HyperlaneIgp;

  keysToFundPerChain: ChainMap<BaseAgentKey[]>;

  constructor(
    public readonly environment: DeployEnvironment,
    public readonly multiProvider: MultiProvider,
    roleKeysPerChain: ChainMap<Record<FundableRole, BaseAgentKey[]>>,
    public readonly context: Contexts,
    public readonly rolesToFund: FundableRole[],
    public readonly skipIgpClaim: boolean,
    public readonly desiredBalancePerChain: KeyFunderConfig['desiredBalancePerChain'],
    public readonly desiredKathyBalancePerChain: KeyFunderConfig['desiredKathyBalancePerChain'],
  ) {
    // At the moment, only blessed EVM chains are supported
    roleKeysPerChain = objFilter(
      roleKeysPerChain,
      (chain, _roleKeys): _roleKeys is Record<Role, BaseAgentKey[]> => {
        const valid =
          isEthereumProtocolChain(chain) &&
          multiProvider.tryGetChainName(chain) !== null;
        if (!valid) {
          logger.warn(
            'Skipping funding for non-blessed or non-Ethereum chain',
            {
              chain,
            },
          );
        }
        return valid;
      },
    );

    this.igp = HyperlaneIgp.fromEnvironment(
      deployEnvToSdkEnv[this.environment],
      multiProvider,
    );
    this.keysToFundPerChain = objMap(roleKeysPerChain, (_chain, roleKeys) => {
      return Object.keys(roleKeys).reduce((agg, roleStr) => {
        const role = roleStr as FundableRole;
        if (this.rolesToFund.includes(role)) {
          return [...agg, ...roleKeys[role]];
        }
        return agg;
      }, [] as BaseAgentKey[]);
    });
  }

  static fromSerializedAddressFile(
    environment: DeployEnvironment,
    multiProvider: MultiProvider,
    contextsAndRolesToFund: ContextAndRolesMap,
    skipIgpClaim: boolean,
    desiredBalancePerChain: KeyFunderConfig['desiredBalancePerChain'],
    desiredKathyBalancePerChain: KeyFunderConfig['desiredKathyBalancePerChain'],
    filePath: string,
  ) {
    logger.info('Reading identifiers and addresses from file', {
      filePath,
    });
    // A big array of KeyAsAddress, including keys that we may not care about.
    const allIdsAndAddresses: KeyAsAddress[] = readJSONAtPath(filePath);
    if (!allIdsAndAddresses.length) {
      throw Error(`Expected at least one key in file ${filePath}`);
    }

    // Arbitrarily pick the first key to get the context
    const firstKey = allIdsAndAddresses[0];
    const context = ReadOnlyCloudAgentKey.fromSerializedAddress(
      firstKey.identifier,
      firstKey.address,
    ).context;

    // Indexed by the identifier for quicker lookup
    const idsAndAddresses: Record<string, KeyAsAddress> =
      allIdsAndAddresses.reduce((agg, idAndAddress) => {
        agg[idAndAddress.identifier] = idAndAddress;
        return agg;
      }, {} as Record<string, KeyAsAddress>);

    const agentConfig = getAgentConfig(context, environment);
    // Unfetched keys per chain and role, so we know which keys
    // we need. We'll use this to create a corresponding object
    // of ReadOnlyCloudAgentKeys using addresses found in the
    // serialized address file.
    const roleKeysPerChain = getRoleKeysPerChain(agentConfig);

    const readOnlyKeysPerChain = objMap(
      roleKeysPerChain,
      (_chain, roleKeys) => {
        return objMap(roleKeys, (_role, keys) => {
          return keys.map((key) => {
            const idAndAddress = idsAndAddresses[key.identifier];
            if (!idAndAddress) {
              throw Error(
                `Expected key identifier ${key.identifier} to be in file ${filePath}`,
              );
            }
            return ReadOnlyCloudAgentKey.fromSerializedAddress(
              idAndAddress.identifier,
              idAndAddress.address,
            );
          });
        });
      },
    );

    logger.info('Successfully read keys for context from file', {
      filePath,
      readOnlyKeysPerChain,
      context,
    });

    return new ContextFunder(
      environment,
      multiProvider,
      readOnlyKeysPerChain,
      context,
      contextsAndRolesToFund[context]!,
      skipIgpClaim,
      desiredBalancePerChain,
      desiredKathyBalancePerChain,
    );
  }

  // the keys are retrieved from the local artifacts in the infra/config/relayer.json or infra/config/kathy.json
  static async fromLocal(
    environment: DeployEnvironment,
    multiProvider: MultiProvider,
    context: Contexts,
    rolesToFund: FundableRole[],
    skipIgpClaim: boolean,
    desiredBalancePerChain: KeyFunderConfig['desiredBalancePerChain'],
    desiredKathyBalancePerChain: KeyFunderConfig['desiredKathyBalancePerChain'],
  ) {
    // only roles that are fundable keys ie. relayer and kathy
    const fundableRoleKeys: Record<FundableRole, Address> = {
      [Role.Relayer]: '',
      [Role.Kathy]: '',
    };
    const roleKeysPerChain: ChainMap<Record<FundableRole, BaseAgentKey[]>> = {};
    const chains = getEnvironmentConfig(environment).chainMetadataConfigs;
    for (const role of rolesToFund) {
      assertFundableRole(role); // only the relayer and kathy are fundable keys
      const roleAddress = fetchLocalKeyAddresses(role)[environment][context];
      if (!roleAddress) {
        throw Error(
          `Could not find address for ${role} in ${environment} ${context}`,
        );
      }
      fundableRoleKeys[role] = roleAddress;

      for (const chain of Object.keys(chains)) {
        if (!roleKeysPerChain[chain as ChainName]) {
          roleKeysPerChain[chain as ChainName] = {
            [Role.Relayer]: [],
            [Role.Kathy]: [],
          };
        }
        roleKeysPerChain[chain][role] = [
          new LocalAgentKey(
            environment,
            context,
            role,
            fundableRoleKeys[role as FundableRole],
            chain,
          ),
        ];
      }
    }
    return new ContextFunder(
      environment,
      multiProvider,
      roleKeysPerChain,
      context,
      rolesToFund,
      skipIgpClaim,
      desiredBalancePerChain,
      desiredKathyBalancePerChain,
    );
  }

  // Funds all the roles in this.rolesToFund
  // Returns whether a failure occurred.
  async fund(): Promise<boolean> {
    const chainKeyEntries = Object.entries(this.keysToFundPerChain);
    const promises = chainKeyEntries.map(async ([chain, keys]) => {
      let failureOccurred = false;
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
      return failureOccurred;
    });

    // A failure occurred if any of the promises rejected or
    // if any of them resolved with true, indicating a failure
    // somewhere along the way
    const failureOccurred = (await Promise.allSettled(promises)).reduce(
      (failureAgg, result, i) => {
        if (result.status === 'rejected') {
          logger.error('Funding promise for chain rejected', {
            chain: chainKeyEntries[i][0],
            error: format(result.reason),
          });
          return true;
        }
        return result.value || failureAgg;
      },
      false,
    );

    return failureOccurred;
  }

  private async attemptToFundKey(
    key: BaseAgentKey,
    chain: ChainName,
  ): Promise<boolean> {
    const provider = this.multiProvider.tryGetProvider(chain);
    if (!provider) {
      logger.error('Cannot get chain connection', {
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
      logger.error('Error funding key', {
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
        this.desiredBalancePerChain[chain],
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
      logger.warn(`No IGP claim threshold for chain ${chain}`);
      return;
    }
    const igpClaimThreshold = ethers.utils.parseEther(igpClaimThresholdEther);

    const provider = this.multiProvider.getProvider(chain);
    const igp = this.igp.getContracts(chain).interchainGasPaymaster;
    const igpBalance = await provider.getBalance(igp.address);

    logger.info('Checking IGP balance', {
      chain,
      igpBalance: ethers.utils.formatEther(igpBalance),
      igpClaimThreshold: ethers.utils.formatEther(igpClaimThreshold),
    });

    if (igpBalance.gt(igpClaimThreshold)) {
      logger.info('IGP balance exceeds claim threshold, claiming', {
        chain,
      });
      await this.multiProvider.sendTransaction(
        chain,
        await igp.populateTransaction.claim(),
      );
    } else {
      logger.info('IGP balance does not exceed claim threshold, skipping', {
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
      role === Role.Kathy && this.desiredKathyBalancePerChain[chain]
        ? this.desiredKathyBalancePerChain[chain]
        : this.desiredBalancePerChain[chain];
    let desiredBalance = ethers.utils.parseEther(desiredBalanceEther ?? '0');
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
    key: BaseAgentKey,
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
      logger.info('Skipping funding for key', {
        key: keyInfo,
        context: this.context,
        chain,
      });
      return;
    } else {
      logger.info('Funding key', {
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
    logger.info('Sent transaction', {
      key: keyInfo,
      txUrl: this.multiProvider.tryGetExplorerTxUrl(chain, {
        hash: tx.transactionHash,
      }),
      context: this.context,
      chain,
    });
    logger.info('Got transaction receipt', {
      key: keyInfo,
      tx,
      context: this.context,
      chain,
    });
  }

  private async bridgeToL2(l2Chain: L2Chain, to: string, amount: BigNumber) {
    const l1Chain = L2ToL1[l2Chain];
    logger.info('Bridging ETH to L2', {
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
    if (l2Chain.includes('optimism') || l2Chain.includes('base')) {
      tx = await this.bridgeToOptimism(l2Chain, amount, to);
    } else if (l2Chain.includes('arbitrum')) {
      tx = await this.bridgeToArbitrum(l2Chain, amount);
    } else if (l2Chain.includes('scroll')) {
      tx = await this.bridgeToScroll(l2Chain, amount, to);
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

  private async bridgeToScroll(
    l2Chain: L2Chain,
    amount: BigNumber,
    to: Address,
  ) {
    const l1Chain = L2ToL1[l2Chain];
    const l1ChainSigner = this.multiProvider.getSigner(l1Chain);
    const l1EthGateway = new ethers.Contract(
      nativeBridges.scrollsepolia.l1ETHGateway,
      L1ETHGateway.abi,
      l1ChainSigner,
    );
    const l1ScrollMessenger = new ethers.Contract(
      nativeBridges.scrollsepolia.l1Messenger,
      L1ScrollMessenger.abi,
      l1ChainSigner,
    );
    const l2GasLimit = BigNumber.from('200000'); // l2 gas amount for the transfer and an empty callback calls
    const l1MessageQueueAddress = await l1ScrollMessenger.messageQueue();
    const l1MessageQueue = new ethers.Contract(
      l1MessageQueueAddress,
      L1MessageQueue.abi,
      l1ChainSigner,
    );
    const gasQuote = await l1MessageQueue.estimateCrossDomainMessageFee(
      l2GasLimit,
    );
    const totalAmount = amount.add(gasQuote);
    return l1EthGateway['depositETH(address,uint256,uint256)'](
      to,
      amount,
      l2GasLimit,
      {
        value: totalAmount,
      },
    );
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
  key: BaseAgentKey,
  chain: ChainName,
  provider: ethers.providers.Provider,
) {
  return {
    ...(await getAddressInfo(key.address, chain, provider)),
    context: (key as LocalAgentKey).context,
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
        `Invalid fundable role ${role}, must be one of ${Array.from(
          validRoles,
        )}`,
      );
    }
  }

  return {
    context,
    roles,
  };
}

function parseBalancePerChain(strs: string[]): ChainMap<string> {
  const balanceMap: ChainMap<string> = {};
  strs.forEach((str) => {
    const [chain, balance] = str.split('=');
    if (!chain || !balance) {
      throw new Error(`Invalid format for balance entry: ${str}`);
    }
    balanceMap[chain] = balance;
  });
  return balanceMap;
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
    logger.error(errorMessage, {
      chain,
      error: format(err),
    });
  }
  return true;
}

main().catch((err) => {
  logger.error('Error occurred in main', {
    // JSON.stringifying an Error returns '{}'.
    // This is a workaround from https://stackoverflow.com/a/60370781
    error: format(err),
  });
  process.exit(1);
});
