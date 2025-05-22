import { Keypair, Signer } from '@solana/web3.js';
import { Registry } from 'prom-client';
import { format } from 'util';

import {
  ChainMap,
  ChainMetadata,
  ChainName,
  MultiProtocolProvider,
  MultiProtocolProviderOptions,
  ProviderType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getChains } from '../../config/registry.js';
import {
  LocalRoleAddresses,
  fetchLocalKeyAddresses,
} from '../../src/agents/key-utils.js';
import { LocalAgentKey } from '../../src/agents/keys.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import { MultiProtocolContextFunder } from '../../src/funding/MultiProtocolContextFunder.js';
import {
  L1_CHAIN,
  L2_CHAINS,
  createTimeoutPromise,
  parseBalancePerChain,
  parseContextAndRolesMap,
} from '../../src/funding/helpers.js';
import {
  ChainFundingPlan,
  FundingAddresses,
  FundingConfig,
  KeyFundingInfo,
} from '../../src/funding/types.js';
import {
  getWalletBalanceGauge,
  submitMetrics,
} from '../../src/utils/metrics.js';
import { chainIsProtocol } from '../../src/utils/utils.js';
import { getArgs, getKeyForRole } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

import { Role } from './../../src/roles.js';

const logger = rootLogger.child({ module: 'fund-keys' });

const DEFAULT_FUNDING_THRESHOLD_FACTOR = 0.7;
const FUNDING_DISCOUNT_FACTOR = 0.2;

const CONTEXT_FUNDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const metricsRegister = new Registry();

const walletBalanceGauge = getWalletBalanceGauge(metricsRegister, [
  'hyperlane_deployment',
  'hyperlane_context',
]);

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
    .choices('chain-skip-override', getChains())
    .coerce('chain-skip-override', (chains: string[]) =>
      Array.from(new Set(chains)),
    )
    .default('chain-skip-override', [] as ChainName[]).argv;

  const config = getEnvironmentConfig(environment);
  const supportedChains = config.supportedChainNames;
  const configuredChains = new Set([
    ...Object.keys(argv.desiredBalancePerChain),
    ...Object.keys(argv.desiredKathyBalancePerChain ?? []),
  ]);
  const chainsToSkip = new Set(argv.chainSkipOverride);

  validateArguments(
    chainsToSkip,
    supportedChains,
    argv.contextsAndRoles,
    argv.desiredKathyBalancePerChain,
  );

  const registry = await config.getRegistry();
  const chainMetadata = await registry.getMetadata();
  const chainAddresses = await registry.getAddresses();
  const chainsToFund = Array.from(supportedChains).filter(
    (chain) =>
      configuredChains.has(chain) &&
      !chainsToSkip.has(chain) &&
      // only support ethereum and sealevel for now
      (chainMetadata[chain].protocol === ProtocolType.Ethereum ||
        chainMetadata[chain].protocol === ProtocolType.Sealevel),
  );

  // filter chainMetadata to only include chainsToFund
  const filteredChainMetadata = Object.fromEntries(
    Object.entries(chainMetadata).filter(([chain]) =>
      chainsToFund.includes(chain),
    ),
  );

  // Add ethereum metadata if we have L2 chains that need it for bridging
  const needsL1 = chainsToFund.some((chain) => L2_CHAINS.includes(chain));

  if (needsL1) {
    filteredChainMetadata.ethereum = chainMetadata.ethereum;
  }

  const multiProtocolProviderOptions = await buildMultiProtocolProviderOptions(
    environment,
    needsL1 ? [...chainsToFund, L1_CHAIN] : chainsToFund,
  );

  const multiProtocolProvider = new MultiProtocolProvider(
    filteredChainMetadata,
    multiProtocolProviderOptions,
  );

  // read address from chain metadata
  const fundingAddresses: ChainMap<FundingAddresses> = chainsToFund.reduce(
    (acc, chain) => {
      acc[chain] = {
        interchainGasPaymaster:
          chain === 'lumia'
            ? '0x9024A3902B542C87a5C4A2b3e15d60B2f087Dc3E'
            : chainAddresses[chain].interchainGasPaymaster,
      };
      return acc;
    },
    {} as ChainMap<FundingAddresses>,
  );

  if (needsL1) {
    fundingAddresses[L1_CHAIN] = {
      interchainGasPaymaster: chainAddresses.ethereum.interchainGasPaymaster,
    };
  }

  if (chainsToFund.length === 0) {
    throw new Error('No valid chains to fund');
  }

  logger.info(
    { chainsToFund },
    'Determined chains to fund based on configuration',
  );

  const multiProtocolContextFunders = Object.entries(argv.contextsAndRoles).map(
    ([context, roles]) => {
      const ctx = context as Contexts;

      const fundingConfig: FundingConfig = {
        skipIgpClaim: argv.skipIgpClaim,
        fundingThresholdFactor: DEFAULT_FUNDING_THRESHOLD_FACTOR,
      };

      // add funding discount factor for all non-hyperlane context i.e RC, neutron
      let fundingDiscountFactor: number | undefined;
      if (ctx !== Contexts.Hyperlane) {
        fundingDiscountFactor = FUNDING_DISCOUNT_FACTOR;
      }

      const fundingPlan = buildFundingPlan(
        ctx,
        environment,
        roles,
        chainsToFund,
        argv.desiredBalancePerChain,
        argv.desiredKathyBalancePerChain,
        chainMetadata,
        Array.from(chainsToSkip),
        argv.igpClaimThresholdPerChain,
        fundingDiscountFactor,
      );

      return new MultiProtocolContextFunder(
        ctx,
        environment,
        multiProtocolProvider,
        fundingConfig,
        walletBalanceGauge,
        fundingAddresses,
        fundingPlan,
      );
    },
  );

  let failureOccurred = false;
  for (const funder of multiProtocolContextFunders) {
    const { promise, cleanup } = createTimeoutPromise(
      CONTEXT_FUNDING_TIMEOUT_MS,
      `Funding timed out for context ${funder.context} after ${
        CONTEXT_FUNDING_TIMEOUT_MS / 1000
      }s`,
    );

    try {
      await Promise.race([funder.fund(), promise]);
    } catch {
      logger.error({ context: funder.context }, 'Error funding context');
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

/**
 * Builds a funding plan for a given context
 * @param context - The context to build the funding plan for
 * @param environment - The environment to build the funding plan for
 * @param roles - The roles to fund for the given context
 * @param desiredBalancePerChain - The desired balances for each chain
 * @param desiredKathyBalancePerChain - The desired Kathy balance per chain
 * @param chainMetadata - The chain metadata
 * @param chainsToSkip - The chains to skip funding for
 * @param igpClaimThresholdPerChain - The IGP claim threshold for each chain
 * @param fundingDiscountFactor - The funding discount factor for the given context
 */
function buildFundingPlan(
  context: Contexts,
  environment: DeployEnvironment,
  roles: Role[],
  chainToFund: ChainName[],
  desiredBalancePerChain: Record<string, string>,
  desiredKathyBalancePerChain: Record<string, string> | undefined,
  chainMetadata: ChainMap<ChainMetadata>,
  chainsToSkip: ChainName[],
  igpClaimThresholdPerChain?: ChainMap<string>,
  fundingDiscountFactor?: number,
): Record<string, ChainFundingPlan> {
  const fundingPlan: Record<string, ChainFundingPlan> = {};

  // Process each chain that has a desired balance
  for (const chain of chainToFund) {
    if (chainsToSkip.includes(chain)) continue;

    const keysToFund: KeyFundingInfo[] = [];

    // Process each role directly
    for (const role of roles) {
      let balance: string | undefined;

      if (role === Role.Relayer) {
        balance = desiredBalancePerChain[chain];
      } else if (role === Role.Kathy) {
        balance = desiredKathyBalancePerChain?.[chain];
      }

      if (!balance) {
        logger.debug(
          { chain, role },
          'No balance found for role, skipping funding',
        );
        continue;
      }

      let localKeysAddresses: LocalRoleAddresses | undefined;
      try {
        localKeysAddresses = fetchLocalKeyAddresses(
          role,
          chainMetadata[chain].protocol,
        );
      } catch {
        logger.warn(
          { chain, role },
          'could not fetch local key addresses, skipping funding',
        );
        continue;
      }

      const roleAddress = localKeysAddresses?.[environment]?.[context];
      if (!roleAddress) {
        logger.warn(
          { chain, role, localKeysAddresses },
          'No local key addresses found, skipping funding',
        );
        continue;
      }

      const key = new LocalAgentKey(
        environment,
        context,
        role,
        roleAddress,
        chain,
      );

      keysToFund.push({
        key,
        desiredBalance: fundingDiscountFactor
          ? Number(balance) * fundingDiscountFactor
          : Number(balance),
      });
    }

    // Determine IGP claim threshold for this chain
    let igpClaimThreshold: number;
    if (igpClaimThresholdPerChain?.[chain]) {
      igpClaimThreshold = Number(igpClaimThresholdPerChain[chain]);
    } else {
      // fallback to 1/5 of relayer desired balance
      igpClaimThreshold = Number(desiredBalancePerChain[chain]) / 5;
    }

    fundingPlan[chain] = {
      keysToFund,
      igpClaimThreshold,
    };
  }

  return fundingPlan;
}

// TODO: this could probably be a generic helper function defined somewhere else
/**
 * Builds a multi-protocol provider options object for a given environment and chains
 * @param environment - The environment to build the multi-protocol provider options for
 * @param chainsToFund - The chains to fund
 * @param chainMetadata - The chain metadata
 */
async function buildMultiProtocolProviderOptions(
  environment: DeployEnvironment,
  chainsToFund: ChainName[],
): Promise<MultiProtocolProviderOptions> {
  const options: MultiProtocolProviderOptions = {
    signers: {},
  };

  // Set up signers for each chain
  for (const chain of chainsToFund) {
    if (chainIsProtocol(chain, ProtocolType.Ethereum)) {
      // Get EVM deployer key
      const key = getKeyForRole(
        environment,
        Contexts.Hyperlane,
        Role.Deployer,
        chain,
      );
      const signer = await key.getSigner();
      options.signers![chain] = {
        [ProviderType.EthersV5]: {
          type: ProviderType.EthersV5,
          signer,
        },
      };
    }

    if (chainIsProtocol(chain, ProtocolType.Sealevel)) {
      const key = getKeyForRole(
        environment,
        Contexts.Hyperlane,
        Role.Deployer,
        chain,
        undefined,
        ProtocolType.Sealevel,
      );
      // TODO: this logic should be abstracted away to somewhere else
      await key.fetch();
      const jsonString = Buffer.from(key.privateKey, 'base64').toString('utf8');
      const secretKeyArray = JSON.parse(jsonString);
      const keyPair = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));
      const solanaSigner: Signer = {
        publicKey: keyPair.publicKey,
        secretKey: keyPair.secretKey,
      };
      options.signers![chain] = {
        [ProviderType.SolanaWeb3]: {
          type: ProviderType.SolanaWeb3,
          signer: solanaSigner,
        },
      };
    }
  }

  return options;
}

/**
 * Validates the arguments for the multi-protocol key funder
 * @param chainsToSkip - The chains to skip funding for
 * @param supportedChains - The supported chains
 * @param contextsAndRoles - The contexts and roles to fund
 * @param desiredKathyBalancePerChain - The desired Kathy balance per chain
 */
function validateArguments(
  chainsToSkip: Set<ChainName>,
  supportedChains: ChainName[],
  contextsAndRoles: Record<string, string[]>,
  desiredKathyBalancePerChain?: Record<string, string>,
) {
  // check if chainsToSkip is a subset of supportedChain
  if (
    !Array.from(chainsToSkip).every((chain) => supportedChains.includes(chain))
  ) {
    throw new Error(
      `Invalid chain skip override: ${Array.from(chainsToSkip).filter(
        (chain) => !supportedChains.includes(chain),
      )}`,
    );
  }

  if (
    Object.values(contextsAndRoles).some((roles) => roles.includes(Role.Kathy))
  ) {
    if (!desiredKathyBalancePerChain) {
      throw new Error(
        'context-and-roles defines kathy but no desired-kathy-balance-per-chain',
      );
    }
  }
}

main().catch((err) => {
  logger.error(
    {
      error: format(err),
    },
    'Error occurred in main',
  );
  process.exit(1);
});
