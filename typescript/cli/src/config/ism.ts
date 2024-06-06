import { confirm, input, select } from '@inquirer/prompts';
import { z } from 'zod';

import {
  AggregationIsmConfig,
  ChainMap,
  IsmConfig,
  IsmConfigSchema,
  IsmType,
  MultisigIsmConfig,
  TrustedRelayerIsmConfig,
} from '@hyperlane-xyz/sdk';

import { CommandContext } from '../context/types.js';
import { logBlue, logBoldUnderlinedRed, logRed } from '../logger.js';
import {
  detectAndConfirmOrPrompt,
  runMultiChainSelectionStep,
} from '../utils/chains.js';
import { readYamlOrJson } from '../utils/files.js';

import { callWithConfigCreationLogsAsync } from './utils.js';

const IsmConfigMapSchema = z.record(IsmConfigSchema).refine(
  (ismConfigMap) => {
    // check if any key in IsmConfigMap is found in its own RoutingIsmConfigSchema.domains
    for (const [key, config] of Object.entries(ismConfigMap)) {
      if (typeof config === 'string') {
        continue;
      }

      if (config.type === IsmType.ROUTING) {
        if (config.domains && key in config.domains) {
          return false;
        }
      }
    }
    return true;
  },
  {
    message:
      'Cannot set RoutingIsm.domain to the same chain you are configuring',
  },
);

export function parseIsmConfig(filePath: string) {
  const config = readYamlOrJson(filePath);
  if (!config) throw new Error(`No ISM config found at ${filePath}`);
  return IsmConfigMapSchema.safeParse(config);
}

export function readIsmConfig(filePath: string) {
  const result = parseIsmConfig(filePath);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid ISM config: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  const parsedConfig = result.data;
  return parsedConfig;
}

const ISM_TYPE_DESCRIPTIONS: Record<string, string> = {
  [IsmType.MESSAGE_ID_MULTISIG]: 'Validators need to sign just this messageId',
  [IsmType.MERKLE_ROOT_MULTISIG]:
    'Validators need to sign the root of the merkle tree of all messages from origin chain',
  [IsmType.ROUTING]:
    'Each origin chain can be verified by the specified ISM type via RoutingISM',
  [IsmType.FALLBACK_ROUTING]:
    "You can specify ISM type for specific chains you like and fallback to mailbox's default ISM for other chains via DefaultFallbackRoutingISM",
  [IsmType.AGGREGATION]:
    'You can aggregate multiple ISMs into one ISM via AggregationISM',
  [IsmType.TRUSTED_RELAYER]: 'Deliver messages from an authorized address',
  [IsmType.TEST_ISM]:
    'ISM where you can deliver messages without any validation (WARNING: only for testing, do not use in production)',
};

export async function createIsmConfig(
  context: CommandContext,
): Promise<IsmConfig> {
  const moduleType = await select({
    message: 'Select ISM type',
    choices: Object.entries(ISM_TYPE_DESCRIPTIONS).map(
      ([value, description]) => ({
        value,
        description,
      }),
    ),
    pageSize: 10,
  });

  switch (moduleType) {
    case IsmType.MESSAGE_ID_MULTISIG:
      return createMessageIdMultisigConfig(context);
    case IsmType.MERKLE_ROOT_MULTISIG:
      return createMerkleRootMultisigConfig(context);
    case IsmType.ROUTING:
      return createRoutingConfig(context);
    case IsmType.FALLBACK_ROUTING:
      return createFallbackRoutingConfig(context);
    case IsmType.AGGREGATION:
      return createAggregationConfig(context);
    case IsmType.TEST_ISM:
      return { type: IsmType.TEST_ISM };
    case IsmType.TRUSTED_RELAYER:
      return createTrustedRelayerConfig(context);
    default:
      throw new Error(`Invalid ISM type: ${moduleType}}`);
  }
}

export const createMerkleRootMultisigConfig = callWithConfigCreationLogsAsync(
  async (): Promise<MultisigIsmConfig> => {
    const thresholdInput = await input({
      message:
        'Enter threshold of validators (number) for merkle root multisig ISM',
    });
    const threshold = parseInt(thresholdInput, 10);

    const validatorsInput = await input({
      message:
        'Enter validator addresses (comma separated list) for merkle root multisig ISM',
    });
    const validators = validatorsInput.split(',').map((v) => v.trim());
    return {
      type: IsmType.MERKLE_ROOT_MULTISIG,
      threshold,
      validators,
    };
  },
  IsmType.MERKLE_ROOT_MULTISIG,
);

export const createMessageIdMultisigConfig = callWithConfigCreationLogsAsync(
  async (): Promise<MultisigIsmConfig> => {
    const thresholdInput = await input({
      message:
        'Enter threshold of validators (number) for message ID multisig ISM',
    });
    const threshold = parseInt(thresholdInput, 10);

    const validatorsInput = await input({
      message:
        'Enter validator addresses (comma separated list) for message ID multisig ISM',
    });
    const validators = validatorsInput.split(',').map((v) => v.trim());
    return {
      type: IsmType.MESSAGE_ID_MULTISIG,
      threshold,
      validators,
    };
  },
  IsmType.MESSAGE_ID_MULTISIG,
);

export const createTrustedRelayerConfig = callWithConfigCreationLogsAsync(
  async (context: CommandContext): Promise<TrustedRelayerIsmConfig> => {
    const relayer = await detectAndConfirmOrPrompt(
      async () => context.signer?.getAddress(),
      'For trusted relayer ISM, enter',
      'relayer address',
    );
    return {
      type: IsmType.TRUSTED_RELAYER,
      relayer,
    };
  },
  IsmType.TRUSTED_RELAYER,
);

export const createAggregationConfig = callWithConfigCreationLogsAsync(
  async (context: CommandContext): Promise<AggregationIsmConfig> => {
    const isms = parseInt(
      await input({
        message: 'Enter the number of ISMs to aggregate (number)',
      }),
      10,
    );

    const threshold = parseInt(
      await input({
        message: 'Enter the threshold of ISMs for verification (number)',
      }),
      10,
    );

    const modules: Array<IsmConfig> = [];
    for (let i = 0; i < isms; i++) {
      modules.push(await createIsmConfig(context));
    }
    return {
      type: IsmType.AGGREGATION,
      modules,
      threshold,
    };
  },
  IsmType.AGGREGATION,
);

export const createRoutingConfig = callWithConfigCreationLogsAsync(
  async (context: CommandContext): Promise<IsmConfig> => {
    const owner = await input({
      message: 'Enter owner address for routing ISM',
    });
    const ownerAddress = owner;

    const chains = await runMultiChainSelectionStep(
      context.chainMetadata,
      'Select chains to configure routing ISM for',
      true,
    );

    const domainsMap: ChainMap<IsmConfig> = {};
    for (const chain of chains) {
      await confirm({
        message: `You are about to configure routing ISM from source chain ${chain}. Continue?`,
      });
      const config = await createIsmConfig(context);
      domainsMap[chain] = config;
    }
    return {
      type: IsmType.ROUTING,
      owner: ownerAddress,
      domains: domainsMap,
    };
  },
  IsmType.ROUTING,
);

export const createFallbackRoutingConfig = callWithConfigCreationLogsAsync(
  async (context: CommandContext): Promise<IsmConfig> => {
    const owner = await input({
      message: 'Enter owner address for fallback routing ISM',
    });
    const ownerAddress = owner;

    const chains = await runMultiChainSelectionStep(
      context.chainMetadata,
      'Select chains to configure fallback routing ISM for',
      true,
    );

    const domainsMap: ChainMap<IsmConfig> = {};
    for (const chain of chains) {
      await confirm({
        message: `You are about to configure fallback routing ISM from source chain ${chain}. Continue?`,
      });
      const config = await createIsmConfig(context);
      domainsMap[chain] = config;
    }
    return {
      type: IsmType.FALLBACK_ROUTING,
      owner: ownerAddress,
      domains: domainsMap,
    };
  },
  IsmType.FALLBACK_ROUTING,
);

export async function createIsmConfigWithWarningOrDefault({
  context,
  defaultFn,
  advanced = false,
}: {
  context: CommandContext;
  defaultFn: (context: CommandContext) => Promise<IsmConfig>;
  advanced: boolean;
}): Promise<IsmConfig> {
  if (advanced) {
    logBlue('Creating a new advanced ISM config');
    logBoldUnderlinedRed('WARNING: USE AT YOUR RISK.');
    logRed(
      'Advanced ISM configs require knowledge of different ISM types and how they work together topologically. If possible, use the basic ISM configs are recommended.',
    );
    return createIsmConfig(context);
  }

  return defaultFn(context);
}
