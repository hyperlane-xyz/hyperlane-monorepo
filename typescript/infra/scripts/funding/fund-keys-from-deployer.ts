import { EthBridger, getArbitrumNetwork } from '@arbitrum/sdk';
import { CrossChainMessenger } from '@eth-optimism/sdk';
import { BigNumber, ethers } from 'ethers';
import { Registry } from 'prom-client';
import { format } from 'util';

import {
  ChainMap,
  ChainName,
  HyperlaneIgp,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  objFilter,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getEnvAddresses } from '../../config/registry.js';
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
import { DeployEnvironment } from '../../src/config/environment.js';
import {
  ContextAndRolesMap,
  KeyFunderConfig,
} from '../../src/config/funding.js';
import {
  createTimeoutPromise,
  parseBalancePerChain,
  parseContextAndRolesMap,
} from '../../src/funding/helpers.js';
import { FundableRole, Role } from '../../src/roles.js';
import {
  getWalletBalanceGauge,
  submitMetrics,
} from '../../src/utils/metrics.js';
import {
  assertFundableRole,
  isEthereumProtocolChain,
  readJSONAtPath,
} from '../../src/utils/utils.js';
import { getAgentConfig, getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

import L1ETHGateway from './utils/L1ETHGateway.json' with { type: 'json' };
import L1MessageQueue from './utils/L1MessageQueue.json' with { type: 'json' };
import L1ScrollMessenger from './utils/L1ScrollMessenger.json' with { type: 'json' };

const logger = rootLogger.child({ module: 'fund-keys' });

const nativeBridges = {
  scrollsepolia: {
    l1ETHGateway: '0x8A54A2347Da2562917304141ab67324615e9866d',
    l1Messenger: '0x50c7d3e7f7c656493D1D76aaa1a836CedfCBB16A',
  },
};

const L2Chains: ChainName[] = ['optimism', 'arbitrum', 'base'];

const L2ToL1: ChainMap<ChainName> = {
  optimism: 'ethereum',
  arbitrum: 'ethereum',
  base: 'ethereum',
};

// Manually adding these labels as we are using a push gateway,
// and ordinarily these labels would be added via K8s annotations
const constMetricLabels = {
  hyperlane_deployment: '',
  hyperlane_context: 'hyperlane',
};

const metricsRegister = new Registry();

const walletBalanceGauge = getWalletBalanceGauge(
  metricsRegister,
  Object.keys(constMetricLabels),
);

// Min delta is 60% of the desired balance
const MIN_DELTA_NUMERATOR = ethers.BigNumber.from(6);
const MIN_DELTA_DENOMINATOR = ethers.BigNumber.from(10);

// Don't send the full amount over to RC keys
const RC_FUNDING_DISCOUNT_NUMERATOR = ethers.BigNumber.from(2);
const RC_FUNDING_DISCOUNT_DENOMINATOR = ethers.BigNumber.from(10);

const CONTEXT_FUNDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CHAIN_FUNDING_TIMEOUT_MS = 1 * 60 * 1000; // 1 minute

// Need to ensure we don't fund non-vanguard chains in the vanguard contexts
const VANGUARD_CHAINS = ['base', 'arbitrum', 'optimism', 'ethereum', 'bsc'];
const VANGUARD_CONTEXTS: Contexts[] = [Contexts.Vanguard0];

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

    .string('igp-claim-threshold-per-chain')
    .array('igp-claim-threshold-per-chain')
    .describe(
      'igp-claim-threshold-per-chain',
      'Array indicating threshold to claim IGP balance for each chain. Each element is expected as <chainName>=<balance>',
    )
    .coerce('igp-claim-threshold-per-chain', parseBalancePerChain)

    .boolean('skip-igp-claim')
    .describe('skip-igp-claim', 'If true, never claims funds from the IGP')
    .default('skip-igp-claim', false)

    .array('chain-skip-override')
    .describe('chain-skip-override', 'Array of chains to skip funding for')
    .default('chain-skip-override', []).argv;

  constMetricLabels.hyperlane_deployment = environment;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider(
    Contexts.Hyperlane, // Always fund from the hyperlane context
    Role.Deployer, // Always fund from the deployer
  );

  let contextFunders: ContextFunder[];

  if (argv.f) {
    contextFunders = argv.f.map((path) =>
      ContextFunder.fromSerializedAddressFile(
        environment,
        multiProvider,
        argv.contextsAndRoles,
        argv.skipIgpClaim,
        argv.chainSkipOverride,
        argv.desiredBalancePerChain,
        argv.desiredKathyBalancePerChain ?? {},
        argv.igpClaimThresholdPerChain ?? {},
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
          argv.chainSkipOverride,
          argv.desiredBalancePerChain,
          argv.desiredKathyBalancePerChain ?? {},
          argv.igpClaimThresholdPerChain ?? {},
        ),
      ),
    );
  }

  let failureOccurred = false;
  for (const funder of contextFunders) {
    const { promise, cleanup } = createTimeoutPromise(
      CONTEXT_FUNDING_TIMEOUT_MS,
      `Funding timed out for context ${funder.context} after ${
        CONTEXT_FUNDING_TIMEOUT_MS / 1000
      }s`,
    );

    try {
      await Promise.race([funder.fund(), promise]);
    } catch (error) {
      logger.error('Error funding context', {
        error: format(error),
        context: funder.context,
        timeoutMs: CONTEXT_FUNDING_TIMEOUT_MS,
      });
      failureOccurred = true;
    } finally {
      cleanup();
    }
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
    public readonly chainSkipOverride: ChainName[],
    public readonly desiredBalancePerChain: KeyFunderConfig<
      ChainName[]
    >['desiredBalancePerChain'],
    public readonly desiredKathyBalancePerChain: KeyFunderConfig<
      ChainName[]
    >['desiredKathyBalancePerChain'],
    public readonly igpClaimThresholdPerChain: KeyFunderConfig<
      ChainName[]
    >['igpClaimThresholdPerChain'],
  ) {
    // At the moment, only blessed EVM chains are supported
    roleKeysPerChain = objFilter(
      roleKeysPerChain,
      (chain, _roleKeys): _roleKeys is Record<Role, BaseAgentKey[]> => {
        // Skip funding for vanguard contexts on non-vanguard chains
        if (
          VANGUARD_CONTEXTS.includes(this.context) &&
          !VANGUARD_CHAINS.includes(chain)
        ) {
          logger.warn(
            { chain, context: this.context },
            'Skipping funding for vanguard context on non-vanguard chain',
          );
          return false;
        }

        const valid =
          isEthereumProtocolChain(chain) &&
          multiProvider.tryGetChainName(chain) !== null;
        if (!valid) {
          logger.warn(
            { chain },
            'Skipping funding for non-blessed or non-Ethereum chain',
          );
        }
        return valid;
      },
    );

    this.igp = HyperlaneIgp.fromAddressesMap(
      {
        ...getEnvAddresses(this.environment),
        lumia: {
          interchainGasPaymaster: '0x9024A3902B542C87a5C4A2b3e15d60B2f087Dc3E',
        },
      },
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
    chainSkipOverride: ChainName[],
    desiredBalancePerChain: KeyFunderConfig<
      ChainName[]
    >['desiredBalancePerChain'],
    desiredKathyBalancePerChain: KeyFunderConfig<
      ChainName[]
    >['desiredKathyBalancePerChain'],
    igpClaimThresholdPerChain: KeyFunderConfig<
      ChainName[]
    >['igpClaimThresholdPerChain'],
    filePath: string,
  ) {
    logger.info({ filePath }, 'Reading identifiers and addresses from file');
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
      allIdsAndAddresses.reduce(
        (agg, idAndAddress) => {
          agg[idAndAddress.identifier] = idAndAddress;
          return agg;
        },
        {} as Record<string, KeyAsAddress>,
      );

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

    logger.info(
      {
        filePath,
        readOnlyKeysPerChain,
        context,
      },
      'Successfully read keys for context from file',
    );

    return new ContextFunder(
      environment,
      multiProvider,
      readOnlyKeysPerChain,
      context,
      contextsAndRolesToFund[context]!,
      skipIgpClaim,
      chainSkipOverride,
      desiredBalancePerChain,
      desiredKathyBalancePerChain,
      igpClaimThresholdPerChain,
    );
  }

  // the keys are retrieved from the local artifacts in the infra/config/relayer.json or infra/config/kathy.json
  static async fromLocal(
    environment: DeployEnvironment,
    multiProvider: MultiProvider,
    context: Contexts,
    rolesToFund: FundableRole[],
    skipIgpClaim: boolean,
    chainSkipOverride: ChainName[],
    desiredBalancePerChain: KeyFunderConfig<
      ChainName[]
    >['desiredBalancePerChain'],
    desiredKathyBalancePerChain: KeyFunderConfig<
      ChainName[]
    >['desiredKathyBalancePerChain'],
    igpClaimThresholdPerChain: KeyFunderConfig<
      ChainName[]
    >['igpClaimThresholdPerChain'],
  ) {
    // only roles that are fundable keys ie. relayer and kathy
    const fundableRoleKeys: Record<FundableRole, Address> = {
      [Role.Relayer]: '',
      [Role.Kathy]: '',
    };
    const roleKeysPerChain: ChainMap<Record<FundableRole, BaseAgentKey[]>> = {};
    const { supportedChainNames } = getEnvironmentConfig(environment);
    for (const role of rolesToFund) {
      assertFundableRole(role); // only the relayer and kathy are fundable keys
      const roleAddress = fetchLocalKeyAddresses(role, ProtocolType.Ethereum)[
        environment
      ][context];
      if (!roleAddress) {
        throw Error(
          `Could not find address for ${role} in ${environment} ${context}`,
        );
      }
      fundableRoleKeys[role] = roleAddress;

      for (const chain of supportedChainNames) {
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
      chainSkipOverride,
      desiredBalancePerChain,
      desiredKathyBalancePerChain,
      igpClaimThresholdPerChain,
    );
  }
  // Funds all the roles in this.keysToFundPerChain.
  // Throws if any funding operations fail.
  async fund(): Promise<void> {
    const chainKeyEntries = Object.entries(this.keysToFundPerChain);
    const results = await Promise.allSettled(
      chainKeyEntries.map(([chain, keys]) => this.fundChain(chain, keys)),
    );

    if (results.some((result) => result.status === 'rejected')) {
      logger.error('One or more chains failed to fund');
      throw new Error('One or more chains failed to fund');
    }
  }

  private async fundChain(chain: string, keys: BaseAgentKey[]): Promise<void> {
    if (this.chainSkipOverride.includes(chain)) {
      logger.warn(
        { chain },
        `Configured to skip funding operations for chain ${chain}, skipping`,
      );
      return;
    }

    const { promise, cleanup } = createTimeoutPromise(
      CHAIN_FUNDING_TIMEOUT_MS,
      `Timed out funding chain ${chain} after ${
        CHAIN_FUNDING_TIMEOUT_MS / 1000
      }s`,
    );

    try {
      await Promise.race([this.executeFundingOperations(chain, keys), promise]);
    } catch (error) {
      logger.error(
        {
          chain,
          error: format(error),
          timeoutMs: CHAIN_FUNDING_TIMEOUT_MS,
          keysCount: keys.length,
        },
        `Funding operations failed for chain ${chain}.`,
      );
      throw error;
    } finally {
      cleanup();
    }
  }

  private async executeFundingOperations(
    chain: string,
    keys: BaseAgentKey[],
  ): Promise<void> {
    if (keys.length === 0) {
      return;
    }

    if (!this.skipIgpClaim) {
      try {
        await this.attemptToClaimFromIgp(chain);
      } catch (err) {
        logger.error(
          {
            chain,
            error: err,
          },
          `Error claiming from IGP on chain ${chain}`,
        );
      }
    }

    try {
      await this.bridgeIfL2(chain);
    } catch (err) {
      logger.error(
        {
          chain,
          error: err,
        },
        `Error bridging to L2 chain ${chain}`,
      );
      throw err;
    }

    const failedKeys: BaseAgentKey[] = [];
    for (const key of keys) {
      try {
        await this.attemptToFundKey(key, chain);
      } catch (err) {
        logger.error(
          {
            chain,
            key: await getKeyInfo(
              key,
              chain,
              this.multiProvider.getProvider(chain),
            ),
            context: this.context,
            error: err,
          },
          `Error funding key ${key.address} on chain ${chain}`,
        );
        failedKeys.push(key);
      }
    }

    if (failedKeys.length > 0) {
      throw new Error(
        `Failed to fund ${
          failedKeys.length
        } keys on chain ${chain}: ${failedKeys
          .map(({ address, role }) => `${address} (${role})`)
          .join(', ')}`,
      );
    }
  }

  private async attemptToFundKey(
    key: BaseAgentKey,
    chain: ChainName,
  ): Promise<void> {
    const provider = this.multiProvider.tryGetProvider(chain);
    if (!provider) {
      throw new Error(`Cannot get chain connection for ${chain}`);
    }

    const desiredBalance = this.getDesiredBalanceForRole(chain, key.role);
    await this.fundKeyIfRequired(chain, key, desiredBalance);
    await this.updateWalletBalanceGauge(chain);
  }

  private async bridgeIfL2(chain: ChainName): Promise<void> {
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
        await this.bridgeToL2(chain, funderAddress, bridgeAmount);
      }
    }
  }

  // Attempts to claim from the IGP if the balance exceeds the claim threshold.
  // If no threshold is set, infer it by reading the desired balance and dividing that by 5.
  private async attemptToClaimFromIgp(chain: ChainName): Promise<void> {
    // Determine the IGP claim threshold in Ether for the given chain.
    // If a specific threshold is not set, use the desired balance for the chain.
    const igpClaimThresholdEther =
      this.igpClaimThresholdPerChain[chain] ||
      this.desiredBalancePerChain[chain];

    // If neither the IGP claim threshold nor the desired balance is set, log a warning and skip the claim attempt.
    if (!igpClaimThresholdEther) {
      logger.warn(
        { chain },
        `No IGP claim threshold or desired balance for chain ${chain}, skipping`,
      );
      return;
    }

    // Convert the IGP claim threshold from Ether to a BigNumber.
    let igpClaimThreshold = ethers.utils.parseEther(igpClaimThresholdEther);

    // If the IGP claim threshold is not explicitly set, infer it from the desired balance by dividing it by 5.
    if (!this.igpClaimThresholdPerChain[chain]) {
      igpClaimThreshold = igpClaimThreshold.div(5);
      logger.info(
        { chain },
        'Inferring IGP claim threshold from desired balance',
      );
    }

    const provider = this.multiProvider.getProvider(chain);
    const igp = this.igp.getContracts(chain).interchainGasPaymaster;
    const igpBalance = await provider.getBalance(igp.address);

    logger.info(
      {
        chain,
        igpBalance: ethers.utils.formatEther(igpBalance),
        igpClaimThreshold: ethers.utils.formatEther(igpClaimThreshold),
      },
      'Checking IGP balance',
    );

    if (igpBalance.gt(igpClaimThreshold)) {
      logger.info({ chain }, 'IGP balance exceeds claim threshold, claiming');
      await this.multiProvider.sendTransaction(
        chain,
        await igp.populateTransaction.claim(),
      );
    } else {
      logger.info(
        { chain },
        'IGP balance does not exceed claim threshold, skipping',
      );
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
    let desiredBalanceEther: string | undefined;
    if (role === Role.Kathy) {
      const desiredKathyBalance = this.desiredKathyBalancePerChain[chain];
      if (desiredKathyBalance === undefined) {
        logger.warn({ chain }, 'No desired balance for Kathy, not funding');
        desiredBalanceEther = '0';
      } else {
        desiredBalanceEther = this.desiredKathyBalancePerChain[chain];
      }
    } else {
      desiredBalanceEther = this.desiredBalancePerChain[chain];
    }
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
      logger.info(
        {
          key: keyInfo,
          context: this.context,
          chain,
        },
        'Skipping funding for key',
      );
      return;
    } else {
      logger.info(
        {
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
        },
        'Funding key',
      );
    }

    const tx = await this.multiProvider.sendTransaction(chain, {
      to: key.address,
      value: fundingAmount,
    });
    logger.info(
      {
        key: keyInfo,
        txUrl: this.multiProvider.tryGetExplorerTxUrl(chain, {
          hash: tx.transactionHash,
        }),
        context: this.context,
        chain,
      },
      'Sent transaction',
    );
    logger.info(
      {
        key: keyInfo,
        tx,
        context: this.context,
        chain,
      },
      'Got transaction receipt',
    );
  }

  private async bridgeToL2(l2Chain: ChainName, to: string, amount: BigNumber) {
    const l1Chain = L2ToL1[l2Chain];
    logger.info(
      {
        l1Chain,
        l2Chain,
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
      },
      'Bridging ETH to L2',
    );
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
    l2Chain: ChainName,
    amount: BigNumber,
    to: string,
  ) {
    const l1Chain = L2ToL1[l2Chain];
    const crossChainMessenger = new CrossChainMessenger({
      l1ChainId: this.multiProvider.getEvmChainId(l1Chain),
      l2ChainId: this.multiProvider.getEvmChainId(l2Chain),
      l1SignerOrProvider: this.multiProvider.getSignerOrProvider(l1Chain),
      l2SignerOrProvider: this.multiProvider.getSignerOrProvider(l2Chain),
    });
    return crossChainMessenger.depositETH(amount, {
      recipient: to,
      overrides: this.multiProvider.getTransactionOverrides(l1Chain),
    });
  }

  private async bridgeToArbitrum(l2Chain: ChainName, amount: BigNumber) {
    const l1Chain = L2ToL1[l2Chain];
    const l2Network = await getArbitrumNetwork(
      this.multiProvider.getEvmChainId(l2Chain),
    );
    const ethBridger = new EthBridger(l2Network);
    return ethBridger.deposit({
      amount,
      parentSigner: this.multiProvider.getSigner(l1Chain),
      overrides: this.multiProvider.getTransactionOverrides(l1Chain),
    });
  }

  private async bridgeToScroll(
    l2Chain: ChainName,
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
    const gasQuote =
      await l1MessageQueue.estimateCrossDomainMessageFee(l2GasLimit);
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

main().catch((err) => {
  logger.error(
    {
      // JSON.stringifying an Error returns '{}'.
      // This is a workaround from https://stackoverflow.com/a/60370781
      error: format(err),
    },
    'Error occurred in main',
  );
  process.exit(1);
});
