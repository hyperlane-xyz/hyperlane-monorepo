import { input, select } from '@inquirer/prompts';
import { z } from 'zod';

import {
  AggregationIsmConfig,
  ChainMap,
  IsmConfig,
  IsmConfigSchema,
  IsmType,
  MultisigIsmConfig,
  RpcValidatorIsmConfig,
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
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../utils/chains.js';
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
  [IsmType.MESSAGE_ID_MULTISIG]: 'Validators need to sign just this messageId',
  [IsmType.ROUTING]:
    'Each origin chain can be verified by the specified ISM type via RoutingISM',
  [IsmType.TEST_ISM]:
    'ISM where you can deliver messages without any validation (WARNING: only for testing, do not use in production)',
  [IsmType.TRUSTED_RELAYER]: 'Deliver messages from an authorized address',
  [IsmType.RPC_VALIDATOR]: 'Deliber messages with an RPC validator',
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
      return createMerkleRootMultisigConfig(context);
    case IsmType.MESSAGE_ID_MULTISIG:
      return createMessageIdMultisigConfig(context);
    case IsmType.ROUTING:
      return createRoutingConfig(context);
    case IsmType.TEST_ISM:
      return { type: IsmType.TEST_ISM };
    case IsmType.TRUSTED_RELAYER:
      return createTrustedRelayerConfig(context, true);
    case IsmType.RPC_VALIDATOR:
      console.log('creating the config');
      return createRpcValidatorIsmConfig(context);
    default:
      console.log('something something');
      throw new Error(`Invalid ISM type: ${moduleType}.`);
  }
}

export const createMerkleRootMultisigConfig = callWithConfigCreationLogs(
  async (): Promise<MultisigIsmConfig> => {
    const validatorsInput = await input({
      message:
        'Enter validator addresses (comma separated list) for merkle root multisig ISM:',
    });
    const validators = validatorsInput.split(',').map((v) => v.trim());
    const thresholdInput = await input({
      message:
        'Enter threshold of validators (number) for merkle root multisig ISM:',
    });
    const threshold = parseInt(thresholdInput, 10);
    if (threshold > validators.length) {
      errorRed(
        `Merkle root multisig signer threshold (${threshold}) cannot be greater than total number of validators (${validators.length}).`,
      );
      throw new Error('Invalid protocol fee.');
    }
    return {
      type: IsmType.MERKLE_ROOT_MULTISIG,
      threshold,
      validators,
    };
  },
  IsmType.MERKLE_ROOT_MULTISIG,
);

export const createMessageIdMultisigConfig = callWithConfigCreationLogs(
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

export const createRpcValidatorIsmConfig = callWithConfigCreationLogs(
  async (context: CommandContext): Promise<RpcValidatorIsmConfig> => {
    const chain = await runSingleChainSelectionStep(
      context.chainMetadata,
      'Select the chain for which to validate',
    );

    const thresholdInput = await input({
      message:
        'Enter threshold of validators (number) for rpc validator config',
    });
    const threshold = parseInt(thresholdInput, 10);

    const validatorsInput = await input({
      message:
        'Enter validator addresses (comma separated list) for rpc validator config',
    });
    const validators = validatorsInput.split(',').map((v) => v.trim());

    const availableRpcUrls = (await context.registry.getChainMetadata(chain))!
      .rpcUrls;

    const selectWithOverride = async (
      options: string[],
      message = 'Pick from the options',
      overrideOptionName = 'Enter something custom ...',
    ) => {
      const selectedOption = await select({
        message,
        choices: options.concat(overrideOptionName).map((_) => ({
          name: _,
          value: _,
        })),
      });

      if (selectedOption !== overrideOptionName) return selectedOption;

      const override = await input({
        message: 'Enter custom value',
      });

      return override;
    };

    const rpcUrl = await selectWithOverride(
      availableRpcUrls.map((_) => _.http),
    );

    return {
      type: IsmType.RPC_VALIDATOR,
      threshold,
      validators,
      rpcUrl,
      originMerkleTreeHook: (await context.registry.getChainAddresses(chain))!
        .merkleTreeHook,
    };
  },
  IsmType.RPC_VALIDATOR,
);

export const createTrustedRelayerConfig = callWithConfigCreationLogs(
  async (
    context: CommandContext,
    advanced: boolean = false,
  ): Promise<TrustedRelayerIsmConfig> => {
    const relayer =
      !advanced && context.signer
        ? await context.signer.getAddress()
        : await detectAndConfirmOrPrompt(
            async () => context.signer?.getAddress(),
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
    const chains = await runMultiChainSelectionStep(
      context.chainMetadata,
      'Select chains to configure routing ISM for',
      1,
    );

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
    const chains = await runMultiChainSelectionStep(
      context.chainMetadata,
      'Select chains to configure fallback routing ISM for',
      1,
    );

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
