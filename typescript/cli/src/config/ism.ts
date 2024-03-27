import { confirm, input, select } from '@inquirer/prompts';
import { z } from 'zod';

import { ChainMap, ChainName, IsmType, ZHash } from '@hyperlane-xyz/sdk';

import {
  errorRed,
  log,
  logBlue,
  logBoldUnderlinedRed,
  logGreen,
  logRed,
} from '../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import { FileFormat, mergeYamlOrJson, readYamlOrJson } from '../utils/files.js';

import { readChainConfigsIfExists } from './chain.js';

const MultisigIsmConfigSchema = z.object({
  type: z.union([
    z.literal(IsmType.MERKLE_ROOT_MULTISIG),
    z.literal(IsmType.MESSAGE_ID_MULTISIG),
  ]),
  threshold: z.number(),
  validators: z.array(ZHash),
});

const RoutingIsmConfigSchema: z.ZodSchema<any> = z.lazy(() =>
  z.object({
    type: z.union([
      z.literal(IsmType.ROUTING),
      z.literal(IsmType.FALLBACK_ROUTING),
    ]),
    owner: ZHash,
    domains: z.record(IsmConfigSchema),
  }),
);

const AggregationIsmConfigSchema: z.ZodSchema<any> = z
  .lazy(() =>
    z.object({
      type: z.literal(IsmType.AGGREGATION),
      modules: z.array(IsmConfigSchema),
      threshold: z.number(),
    }),
  )
  .refine(
    // check ig modules.length >= threshold
    (ismConfig) => {
      return ismConfig.modules.length >= ismConfig.threshold;
    },
    {
      message: 'Threshold cannot be greater than number of modules',
    },
  );

const TestIsmConfigSchema = z.object({
  type: z.literal(IsmType.TEST_ISM),
});

const IsmConfigSchema = z.union([
  MultisigIsmConfigSchema,
  RoutingIsmConfigSchema,
  AggregationIsmConfigSchema,
  TestIsmConfigSchema,
]);
const IsmConfigMapSchema = z.record(IsmConfigSchema).refine(
  (ismConfigMap) => {
    // check if any key in IsmConfigMap is found in its own RoutingIsmConfigSchema.domains
    for (const [key, config] of Object.entries(ismConfigMap)) {
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
export type ZodIsmConfig = z.infer<typeof IsmConfigSchema>;
export type ZodIsmConfigMap = z.infer<typeof IsmConfigMapSchema>;

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

export function isValildIsmConfig(config: any) {
  return IsmConfigMapSchema.safeParse(config).success;
}

export async function createIsmConfigMap({
  format,
  outPath,
  chainConfigPath,
}: {
  format: FileFormat;
  outPath: string;
  chainConfigPath: string;
}) {
  logBlue('Creating a new advanced ISM config');
  logBoldUnderlinedRed('WARNING: USE AT YOUR RISK.');
  logRed(
    'Advanced ISM configs require knowledge of different ISM types and how they work together topologically. If possible, use the basic ISM configs are recommended.',
  );
  const customChains = readChainConfigsIfExists(chainConfigPath);
  const chains = await runMultiChainSelectionStep(
    customChains,
    'Select chains to configure ISM for',
    true,
  );

  const result: ZodIsmConfigMap = {};
  for (const chain of chains) {
    log(`Setting values for chain ${chain}`);
    result[chain] = await createIsmConfig(chain, chains);

    // TODO consider re-enabling. Disabling based on feedback from @nambrot for now.
    // repeat = await confirm({
    //   message: 'Use this same config for remaining chains?',
    // });
  }

  if (isValildIsmConfig(result)) {
    logGreen(`ISM config is valid, writing to file ${outPath}`);
    mergeYamlOrJson(outPath, result, format);
  } else {
    errorRed(
      `ISM config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/ism.yaml for an example`,
    );
    throw new Error('Invalid ISM config');
  }
}

export async function createIsmConfig(
  remote: ChainName,
  origins: ChainName[],
): Promise<ZodIsmConfig> {
  let lastConfig: ZodIsmConfig;
  const moduleType = await select({
    message: 'Select ISM type',
    choices: [
      {
        value: IsmType.MESSAGE_ID_MULTISIG,
        name: IsmType.MESSAGE_ID_MULTISIG,
        description: 'Validators need to sign just this messageId',
      },
      {
        value: IsmType.MERKLE_ROOT_MULTISIG,
        name: IsmType.MERKLE_ROOT_MULTISIG,
        description:
          'Validators need to sign the root of the merkle tree of all messages from origin chain',
      },
      {
        value: IsmType.ROUTING,
        name: IsmType.ROUTING,
        description:
          'Each origin chain can be verified by the specified ISM type via RoutingISM',
      },
      {
        value: IsmType.FALLBACK_ROUTING,
        name: IsmType.FALLBACK_ROUTING,
        description:
          "You can specify ISM type for specific chains you like and fallback to mailbox's default ISM for other chains via DefaultFallbackRoutingISM",
      },
      {
        value: IsmType.AGGREGATION,
        name: IsmType.AGGREGATION,
        description:
          'You can aggregate multiple ISMs into one ISM via AggregationISM',
      },
      {
        value: IsmType.TEST_ISM,
        name: IsmType.TEST_ISM,
        description:
          'ISM where you can deliver messages without any validation (WARNING: only for testing, do not use in production)',
      },
    ],
    pageSize: 10,
  });
  if (
    moduleType === IsmType.MESSAGE_ID_MULTISIG ||
    moduleType === IsmType.MERKLE_ROOT_MULTISIG
  ) {
    lastConfig = await createMultisigConfig(moduleType);
  } else if (
    moduleType === IsmType.ROUTING ||
    moduleType === IsmType.FALLBACK_ROUTING
  ) {
    lastConfig = await createRoutingConfig(moduleType, remote, origins);
  } else if (moduleType === IsmType.AGGREGATION) {
    lastConfig = await createAggregationConfig(remote, origins);
  } else if (moduleType === IsmType.TEST_ISM) {
    lastConfig = { type: IsmType.TEST_ISM };
  } else {
    throw new Error(`Invalid ISM type: ${moduleType}}`);
  }
  return lastConfig;
}

export async function createMultisigConfig(
  type: IsmType.MERKLE_ROOT_MULTISIG | IsmType.MESSAGE_ID_MULTISIG,
): Promise<ZodIsmConfig> {
  const thresholdInput = await input({
    message: 'Enter threshold of signers (number)',
  });
  const threshold = parseInt(thresholdInput, 10);

  const validatorsInput = await input({
    message: 'Enter validator addresses (comma separated list)',
  });
  const validators = validatorsInput.split(',').map((v) => v.trim());
  return {
    type,
    threshold,
    validators,
  };
}

export async function createAggregationConfig(
  remote: ChainName,
  chains: ChainName[],
): Promise<ZodIsmConfig> {
  const isms = parseInt(
    await input({
      message: 'Enter the number of ISMs to aggregate (number)',
    }),
    10,
  );

  const threshold = parseInt(
    await input({
      message: 'Enter the threshold of ISMs to for verification (number)',
    }),
    10,
  );

  const modules: Array<ZodIsmConfig> = [];
  for (let i = 0; i < isms; i++) {
    modules.push(await createIsmConfig(remote, chains));
  }
  return {
    type: IsmType.AGGREGATION,
    modules,
    threshold,
  };
}

export async function createRoutingConfig(
  type: IsmType.ROUTING | IsmType.FALLBACK_ROUTING,
  remote: ChainName,
  chains: ChainName[],
): Promise<ZodIsmConfig> {
  const owner = await input({
    message: 'Enter owner address',
  });
  const ownerAddress = owner;
  const origins = chains.filter((chain) => chain !== remote);

  const domainsMap: ChainMap<ZodIsmConfig> = {};
  for (const chain of origins) {
    await confirm({
      message: `You are about to configure ISM from source chain ${chain}. Continue?`,
    });
    const config = await createIsmConfig(chain, chains);
    domainsMap[chain] = config;
  }
  return {
    type,
    owner: ownerAddress,
    domains: domainsMap,
  };
}
