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
import {
  detectAndConfirmOrPrompt,
  runMultiChainSelectionStep,
} from '../utils/chains.js';
import { readYamlOrJson } from '../utils/files.js';

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

const ISM_TYPE_DESCRIPTIONS: Record<IsmType, string> = {
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
  [IsmType.OP_STACK]: '',
  [IsmType.PAUSABLE]: '',
  [IsmType.CUSTOM]: '',
};

export async function createIsmConfig(
  context: CommandContext,
): Promise<IsmConfig> {
  const moduleType = await select({
    message: 'Select ISM type',
    choices: Object.values(IsmType).map((value) => ({
      value,
      description: ISM_TYPE_DESCRIPTIONS[value],
    })),
    pageSize: 10,
  });

  if (
    moduleType === IsmType.MESSAGE_ID_MULTISIG ||
    moduleType === IsmType.MERKLE_ROOT_MULTISIG
  ) {
    return createMultisigConfig(moduleType);
  } else if (
    moduleType === IsmType.ROUTING ||
    moduleType === IsmType.FALLBACK_ROUTING
  ) {
    return createRoutingConfig(context, moduleType);
  } else if (moduleType === IsmType.AGGREGATION) {
    return createAggregationConfig(context);
  } else if (moduleType === IsmType.TEST_ISM) {
    return { type: IsmType.TEST_ISM };
  } else if (moduleType === IsmType.TRUSTED_RELAYER) {
    return createTrustedRelayerConfig(context);
  }

  throw new Error(`Invalid ISM type: ${moduleType}}`);
}

export async function createMultisigConfig(
  type: IsmType.MERKLE_ROOT_MULTISIG | IsmType.MESSAGE_ID_MULTISIG,
): Promise<MultisigIsmConfig> {
  const thresholdInput = await input({
    message: 'Enter threshold of validators (number) for multisig ISM',
  });
  const threshold = parseInt(thresholdInput, 10);

  const validatorsInput = await input({
    message:
      'Enter validator addresses (comma separated list) for multisig ISM',
  });
  const validators = validatorsInput.split(',').map((v) => v.trim());
  return {
    type,
    threshold,
    validators,
  };
}

export async function createTrustedRelayerConfig(
  context: CommandContext,
): Promise<TrustedRelayerIsmConfig> {
  const relayer = await detectAndConfirmOrPrompt(
    async () => context.signer?.getAddress(),
    'For trusted relayer ISM, enter',
    'relayer address',
  );
  return {
    type: IsmType.TRUSTED_RELAYER,
    relayer,
  };
}

export async function createAggregationConfig(
  context: CommandContext,
): Promise<AggregationIsmConfig> {
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
}

export async function createRoutingConfig(
  context: CommandContext,
  type: IsmType.ROUTING | IsmType.FALLBACK_ROUTING,
): Promise<IsmConfig> {
  const owner = await input({
    message: 'Enter owner address for routing ISM',
  });
  const ownerAddress = owner;

  const chains = await runMultiChainSelectionStep(
    context.chainMetadata,
    'Select chains to configure ISM for',
    true,
  );

  const domainsMap: ChainMap<IsmConfig> = {};
  for (const chain of chains) {
    await confirm({
      message: `You are about to configure ISM from source chain ${chain}. Continue?`,
    });
    const config = await createIsmConfig(context);
    domainsMap[chain] = config;
  }
  return {
    type,
    owner: ownerAddress,
    domains: domainsMap,
  };
}
