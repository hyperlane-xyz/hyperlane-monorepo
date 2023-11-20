import { confirm, input, select } from '@inquirer/prompts';
import { z } from 'zod';

import { ChainMap, ChainName, IsmType } from '@hyperlane-xyz/sdk';

import { errorRed, log, logBlue, logGreen } from '../../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import { FileFormat, mergeYamlOrJson, readYamlOrJson } from '../utils/files.js';

import { readChainConfigsIfExists } from './chain.js';

const RoutingIsmConfigSchema: z.ZodSchema<any> = z.lazy(() =>
  z.object({
    type: z.literal(IsmType.ROUTING),
    owner: z.string(),
    domains: z.record(IsmConfigSchema),
  }),
);

const MultisigIsmConfigSchema = z.object({
  type: z.literal(IsmType.ROUTING),
  threshold: z.number(),
  validators: z.array(z.string()),
});

const IsmConfigSchema = z.union([
  MultisigIsmConfigSchema,
  RoutingIsmConfigSchema,
]);
const IsmConfigMapSchema = z.record(IsmConfigSchema);
export type ZodIsmConfig = z.infer<typeof IsmConfigSchema>;
export type ZodIsmConfigMap = z.infer<typeof IsmConfigMapSchema>;

export function readMultisigConfig(filePath: string) {
  const config = readYamlOrJson(filePath);
  if (!config) throw new Error(`No multisig config found at ${filePath}`);
  const result = IsmConfigMapSchema.safeParse(config);
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
  logBlue('Creating a new ISM config');
  const customChains = readChainConfigsIfExists(chainConfigPath);
  const chains = await runMultiChainSelectionStep(customChains);

  const result: ZodIsmConfigMap = {};
  for (const chain of chains) {
    log(`Setting values for chain ${chain}`);
    result[chain] = await createIsmConfig(chain, chainConfigPath);

    console.log('lastConfig', result[chain]);

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
  chain: ChainName,
  chainConfigPath: string,
): Promise<ZodIsmConfig> {
  let lastConfig: ZodIsmConfig;
  const moduleType = await select({
    message: 'Select ISM type',
    choices: Object.values(IsmType)
      .filter((c) => c !== IsmType.TEST_ISM)
      .map((type) => ({
        name: type,
        value: type,
      })),
    pageSize: 10,
  });
  if (
    moduleType === IsmType.MESSAGE_ID_MULTISIG ||
    moduleType === IsmType.MERKLE_ROOT_MULTISIG
  ) {
    lastConfig = await createMultisigConfig();
  } else if (moduleType === IsmType.ROUTING) {
    lastConfig = await createRoutingConfig(chain, chainConfigPath);
  } else {
    throw new Error(`Invalid ISM type: ${moduleType}}`);
  }
  return lastConfig;
}

export async function createMultisigConfig(): Promise<ZodIsmConfig> {
  const thresholdInput = await input({
    message: 'Enter threshold of signers (number)',
  });
  const threshold = parseInt(thresholdInput, 10);

  const validatorsInput = await input({
    message: 'Enter validator addresses (comma separated list)',
  });
  const validators = validatorsInput.split(',').map((v) => v.trim());
  return {
    type: IsmType.MERKLE_ROOT_MULTISIG,
    threshold,
    validators,
  };
}

export async function createRoutingConfig(
  chain: ChainName,
  chainConfigPath: string,
): Promise<ZodIsmConfig> {
  const owner = await input({
    message: 'Enter owner address',
  });
  const ownerAddress = owner;
  const customChains = readChainConfigsIfExists(chainConfigPath);
  delete customChains[chain];
  const chains = await runMultiChainSelectionStep(customChains, [chain]);

  const domainsMap: ChainMap<ZodIsmConfig> = {};
  for (const chain of chains) {
    await confirm({
      message: `You are about to configure ISM from source chain ${chain}. Continue?`,
    });
    const config = await createIsmConfig(chain, chainConfigPath);
    domainsMap[chain] = config;
  }
  return {
    type: IsmType.ROUTING,
    owner: ownerAddress,
    domains: domainsMap,
  };
}
