import { input, select } from '@inquirer/prompts';
import { z } from 'zod';

import {
  AggregationIsmConfig,
  ChainMap,
  IsmConfig,
  IsmConfigSchema,
  IsmType,
  MultisigIsmConfig,
  MultisigIsmConfigSchema,
  TrustedRelayerIsmConfig,
} from '@hyperlane-xyz/sdk';

import { CommandContext } from '../context/types.js';
import {
  errorRed,
  log,
  logBlue,
  logBoldUnderlinedRed,
  logRed,
} from '../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import { readYamlOrJson } from '../utils/files.js';
import { detectAndConfirmOrPrompt } from '../utils/input.js';

import { callWithConfigCreationLogs } from './utils.js';

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
  [IsmType.AGGREGATION]:
    'You can aggregate multiple ISMs into one ISM via AggregationISM',
  [IsmType.FALLBACK_ROUTING]:
    "You can specify ISM type for specific chains you like and fallback to mailbox's default ISM for other chains via DefaultFallbackRoutingISM",
  [IsmType.MERKLE_ROOT_MULTISIG]:
    'Validators need to sign the root of the merkle tree of all messages from origin chain',
  [IsmType.STORAGE_MERKLE_ROOT_MULTISIG]:
    'Mutable validators in storage need to sign the root of the merkle tree of all messages from origin chain',
  [IsmType.MESSAGE_ID_MULTISIG]: 'Validators need to sign just this messageId',
  [IsmType.STORAGE_MESSAGE_ID_MULTISIG]:
    'Mutable validators in storage need to sign just this messageId',
  [IsmType.ROUTING]:
    'Each origin chain can be verified by the specified ISM type via RoutingISM',
  [IsmType.TEST_ISM]:
    'ISM where you can deliver messages without any validation (WARNING: only for testing, do not use in production)',
  [IsmType.TRUSTED_RELAYER]: 'Deliver messages from an authorized address',
  [IsmType.AMOUNT_ROUTING]:
    'Route messages based on the token amount to transfer',
};

export async function createAdvancedIsmConfig(
  context: CommandContext,
): Promise<IsmConfig> {
  logBlue('Creating a new advanced ISM config');
  logBoldUnderlinedRed('WARNING: USE AT YOUR RISK.');
  logRed(
    'Advanced ISM configs require knowledge of different ISM types and how they work together topologically. If possible, use the basic ISM configs are recommended.',
  );

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
    case IsmType.AGGREGATION:
      return createAggregationConfig(context);
    case IsmType.FALLBACK_ROUTING:
      return createFallbackRoutingConfig(context);
    case IsmType.MERKLE_ROOT_MULTISIG:
    case IsmType.MESSAGE_ID_MULTISIG:
    case IsmType.STORAGE_MERKLE_ROOT_MULTISIG:
    case IsmType.STORAGE_MESSAGE_ID_MULTISIG:
      return createMultisigConfig(moduleType);
    case IsmType.ROUTING:
      return createRoutingConfig(context);
    case IsmType.TEST_ISM:
      return { type: IsmType.TEST_ISM };
    case IsmType.TRUSTED_RELAYER:
      return createTrustedRelayerConfig(context, true);
    case IsmType.AMOUNT_ROUTING:
      return createAmountRoutingIsmConfig(context);
    default:
      throw new Error(`Unsupported ISM type: ${moduleType}.`);
  }
}

export const createMultisigConfig = async (
  ismType: MultisigIsmConfig['type'],
): Promise<MultisigIsmConfig> => {
  const validatorsInput = await input({
    message:
      'Enter validator addresses (comma separated list) for multisig ISM:',
  });
  const validators = validatorsInput.split(',').map((v) => v.trim());
  const threshold = parseInt(
    await input({
      message: 'Enter threshold of validators (number) for multisig ISM:',
    }),
    10,
  );
  const result = MultisigIsmConfigSchema.safeParse({
    type: ismType,
    validators,
    threshold,
  });
  if (!result.success) {
    errorRed(
      result.error.issues
        .map((input, index) => `input[${index}]: ${input.message}`)
        .join('\n'),
    );
    return createMultisigConfig(ismType);
  }

  return result.data;
};

export const createTrustedRelayerConfig = callWithConfigCreationLogs(
  async (
    context: CommandContext,
    advanced: boolean = false,
  ): Promise<TrustedRelayerIsmConfig> => {
    const relayer =
      !advanced && context.signerAddress
        ? context.signerAddress
        : await detectAndConfirmOrPrompt(
            async () => context.signerAddress,
            'For trusted relayer ISM, enter',
            'relayer address',
            'signer',
          );
    return {
      type: IsmType.TRUSTED_RELAYER,
      relayer,
    };
  },
  IsmType.TRUSTED_RELAYER,
);

export const createAggregationConfig = callWithConfigCreationLogs(
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
      modules.push(await createAdvancedIsmConfig(context));
    }
    return {
      type: IsmType.AGGREGATION,
      modules,
      threshold,
    };
  },
  IsmType.AGGREGATION,
);

export const createRoutingConfig = callWithConfigCreationLogs(
  async (context: CommandContext): Promise<IsmConfig> => {
    const owner = await input({
      message: 'Enter owner address for routing ISM',
    });
    const ownerAddress = owner;
    const chains = await runMultiChainSelectionStep({
      chainMetadata: context.chainMetadata,
      message: 'Select chains to configure routing ISM for',
      requireNumber: 1,
    });

    const domainsMap: ChainMap<IsmConfig> = {};
    for (const chain of chains) {
      log(`You are about to configure routing ISM from source chain ${chain}.`);
      const config = await createAdvancedIsmConfig(context);
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

export const createFallbackRoutingConfig = callWithConfigCreationLogs(
  async (context: CommandContext): Promise<IsmConfig> => {
    const chains = await runMultiChainSelectionStep({
      chainMetadata: context.chainMetadata,
      message: 'Select chains to configure fallback routing ISM for',
      requireNumber: 1,
    });

    const domainsMap: ChainMap<IsmConfig> = {};
    for (const chain of chains) {
      log(
        `You are about to configure fallback routing ISM from source chain ${chain}.`,
      );
      const config = await createAdvancedIsmConfig(context);
      domainsMap[chain] = config;
    }
    return {
      type: IsmType.FALLBACK_ROUTING,
      owner: '',
      domains: domainsMap,
    };
  },
  IsmType.FALLBACK_ROUTING,
);

export const createAmountRoutingIsmConfig = callWithConfigCreationLogs(
  async (context: CommandContext): Promise<IsmConfig> => {
    const lowerIsm = await createAdvancedIsmConfig(context);
    const upperIsm = await createAdvancedIsmConfig(context);

    const threshold = parseInt(
      await input({
        message: 'Enter the threshold amount for routing verification (number)',
      }),
      10,
    );

    return {
      type: IsmType.AMOUNT_ROUTING,
      lowerIsm,
      upperIsm,
      threshold,
    };
  },
  IsmType.AMOUNT_ROUTING,
);
