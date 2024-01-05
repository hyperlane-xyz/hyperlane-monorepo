import { confirm, input, select } from '@inquirer/prompts';
import { BigNumber as BigNumberJs } from 'bignumber.js';
import { BigNumber, ethers } from 'ethers';
import { z } from 'zod';

import {
  ChainMap,
  ChainName,
  GasOracleContractType,
  HookType,
  HooksConfig,
  IgpHookConfig,
  MultiProvider,
  MultisigConfig,
  StorageGasOraclesConfig,
  chainMetadata,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  normalizeAddressEvm,
  objMap,
  toWei,
} from '@hyperlane-xyz/utils';

import { errorRed, log, logBlue, logGreen, logRed } from '../../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import { FileFormat, mergeYamlOrJson, readYamlOrJson } from '../utils/files.js';

import { readChainConfigsIfExists } from './chain.js';

const ProtocolFeeSchema = z.object({
  type: z.literal(HookType.PROTOCOL_FEE),
  owner: z.string(),
  beneficiary: z.string(),
  maxProtocolFee: z.string(),
  protocolFee: z.string(),
});

const MerkleTreeSchema = z.object({
  type: z.literal(HookType.MERKLE_TREE),
});

const StorageGasOracleSchema = z.object({
  type: z.literal(GasOracleContractType.StorageGasOracle),
  tokenExchangeRate: z.string().optional(),
  gasPrice: z.string().optional(),
});
export type StorageGasOracleConfig = z.infer<typeof StorageGasOracleSchema>;

const IgpSchema = z.object({
  type: z.literal(HookType.INTERCHAIN_GAS_PAYMASTER),
  owner: z.string(),
  beneficiary: z.string(),
  oracleConfig: z.record(StorageGasOracleSchema),
  oracleKey: z.string(),
  overhead: z.record(z.string()),
});
export type IgpConfig = z.infer<typeof IgpSchema>;

const RoutingConfigSchema: z.ZodSchema<any> = z.lazy(() =>
  z.object({
    type: z.literal(HookType.ROUTING),
    owner: z.string(),
    domains: z.record(HookConfigSchema),
  }),
);

const AggregationConfigSchema: z.ZodSchema<any> = z.lazy(() =>
  z.object({
    type: z.literal(HookType.AGGREGATION),
    hooks: z.array(HookConfigSchema),
  }),
);

const HookConfigSchema = z.union([
  ProtocolFeeSchema,
  MerkleTreeSchema,
  IgpSchema,
  RoutingConfigSchema,
  AggregationConfigSchema,
]);
export type HookConfig = z.infer<typeof HookConfigSchema>;

const HooksConfigSchema = z.object({
  required: HookConfigSchema,
  default: HookConfigSchema,
});
const HooksConfigMapSchema = z.record(HooksConfigSchema);
export type HooksConfigMap = z.infer<typeof HooksConfigMapSchema>;

export function isValidHookConfigMap(config: any) {
  return HooksConfigMapSchema.safeParse(config).success;
}

async function processIgpConfig(
  multiProvider: MultiProvider,
  igpConfig: IgpConfig,
): Promise<IgpHookConfig> {
  const storageGasOracleConfig: StorageGasOraclesConfig = {};
  Object.keys(igpConfig.oracleConfig).forEach(async (chain) => {
    const userDefinedGasConfig = igpConfig.oracleConfig[chain];
    storageGasOracleConfig[chain] = {
      ...(storageGasOracleConfig[chain] || {}),
      type: userDefinedGasConfig.type,
      tokenExchangeRate: BigNumber.from(
        userDefinedGasConfig.tokenExchangeRate || '10000000000',
      ),
      gasPrice:
        BigNumber.from(userDefinedGasConfig.gasPrice) ||
        (await multiProvider.getGasPrice(chain)),
    };
  });
  const trueIgpConfig: IgpHookConfig = {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    owner: igpConfig.owner,
    beneficiary: igpConfig.beneficiary,
    oracleKey: igpConfig.oracleKey,
    overhead: objMap(igpConfig.overhead, (_, overhead) =>
      BigNumber.from(overhead),
    ),
    oracleConfig: storageGasOracleConfig,
  };
  return trueIgpConfig;
}

async function processNestedIgpConfig(
  multiProvider: MultiProvider,
  hookConfig: HookConfig,
): Promise<any> {
  if (hookConfig.type === HookType.INTERCHAIN_GAS_PAYMASTER) {
    return await processIgpConfig(multiProvider, hookConfig as IgpConfig);
  }

  for (const key in hookConfig) {
    if (hookConfig[key] instanceof Object) {
      hookConfig[key] = await processNestedIgpConfig(
        multiProvider,
        hookConfig[key],
      );
    }
  }

  return hookConfig;
}

export async function presetHookConfigs(
  multiProvider: MultiProvider,
  owner: Address,
  local: ChainName,
  destinationChains: ChainName[],
  multisigConfig?: MultisigConfig,
): Promise<HooksConfig> {
  const oracleConfig: StorageGasOraclesConfig = {};
  const overheads: ChainMap<BigNumber> = {};

  for (const chain of destinationChains) {
    const gasPrice = await multiProvider.getGasPrice(chain);
    let validatorThreshold: number;
    let validatorCount: number;
    if (multisigConfig) {
      validatorThreshold = multisigConfig.threshold;
      validatorCount = multisigConfig.validators.length;
    } else if (local in defaultMultisigConfigs) {
      validatorThreshold = defaultMultisigConfigs[local].threshold;
      validatorCount = defaultMultisigConfigs[local].validators.length;
    } else {
      // default values
      // fix here: https://github.com/hyperlane-xyz/issues/issues/773
      validatorThreshold = 2;
      validatorCount = 3;
    }

    overheads[chain] = BigNumber.from(
      multisigIsmVerificationCost(validatorThreshold, validatorCount),
    );
    oracleConfig[chain] = {
      // 1e10 - both the chains are using the same valued token
      tokenExchangeRate: BigNumber.from('1000000000'),
      gasPrice: BigNumber.from(gasPrice),
      type: GasOracleContractType.StorageGasOracle,
    };
  }

  return {
    required: {
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee: ethers.utils.parseUnits('1', 'gwei').toString(),
      protocolFee: ethers.utils.parseUnits('0', 'wei').toString(),
      beneficiary: owner,
      owner: owner,
    },
    default: {
      type: HookType.AGGREGATION,
      hooks: [
        {
          type: HookType.MERKLE_TREE,
        },
        {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: owner,
          beneficiary: owner,
          oracleConfig,
          overhead: overheads,
          oracleKey: owner,
        },
      ],
    },
  };
}

export async function readHooksConfigMap(
  multiProvider: MultiProvider,
  filePath: string,
) {
  const config = readYamlOrJson(filePath);
  if (!config) {
    logRed(`No hook config found at ${filePath}`);
    return;
  }
  const result = HooksConfigMapSchema.safeParse(config);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid hook config: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  const parsedConfig = result.data;

  // special case for IGP
  for (const chain of Object.keys(parsedConfig)) {
    parsedConfig[chain] = await processNestedIgpConfig(
      multiProvider,
      parsedConfig[chain],
    );
  }

  const hooks: ChainMap<HooksConfig> = objMap(
    parsedConfig,
    (_, config) => config as HooksConfig,
  );

  logGreen(`All hook configs in ${filePath} are valid for ${hooks}`);
  return hooks;
}

export async function createHooksConfigMap({
  format,
  outPath,
  chainConfigPath,
}: {
  format: FileFormat;
  outPath: string;
  chainConfigPath: string;
}) {
  logBlue('Creating a new hook config');
  const customChains = readChainConfigsIfExists(chainConfigPath);
  const chains = await runMultiChainSelectionStep(customChains);

  const result: HooksConfigMap = {};
  for (const chain of chains) {
    for (const hookRequirements of ['required', 'default']) {
      log(`Setting ${hookRequirements} hook for chain ${chain}`);
      const remotes = chains.filter((c) => c !== chain);
      result[chain] = {
        ...result[chain],
        [hookRequirements]: await createHookConfig(chain, remotes),
      };
    }
    if (isValidHookConfigMap(result)) {
      logGreen(`Hook config is valid, writing to file ${outPath}`);
      mergeYamlOrJson(outPath, result, format);
    } else {
      errorRed(
        `Hook config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/hooks.yaml for an example`,
      );
      throw new Error('Invalid hook config');
    }
  }
}

export async function createHookConfig(
  chain: ChainName,
  remotes: ChainName[],
): Promise<HookConfig> {
  let lastConfig: HookConfig;
  const hookType = await select({
    message: 'Select hook type',
    choices: [
      {
        value: HookType.MERKLE_TREE,
        name: HookType.MERKLE_TREE,
        description:
          'Add messages to the incremental merkle tree on origin chain (needed for the merkleRootMultisigIsm on the remote chain)',
      },
      {
        value: HookType.PROTOCOL_FEE,
        name: HookType.PROTOCOL_FEE,
        description: 'Charge fees for each message dispatch from this chain',
      },
      {
        value: HookType.INTERCHAIN_GAS_PAYMASTER,
        name: HookType.INTERCHAIN_GAS_PAYMASTER,
        description:
          'Allow for payments for expected gas to be paid by the relayer while delivering on remote chain',
      },
      {
        value: HookType.AGGREGATION,
        name: HookType.AGGREGATION,
        description:
          'Aggregate multiple hooks into a single hook (e.g. merkle tree + IGP) which will be called in sequence',
      },
      {
        value: HookType.ROUTING,
        name: HookType.ROUTING,
        description:
          'Each destination domain can have its own hook configured via DomainRoutingHook',
      },
    ],
    pageSize: 10,
  });
  if (hookType === HookType.MERKLE_TREE) {
    lastConfig = { type: HookType.MERKLE_TREE };
  } else if (hookType === HookType.PROTOCOL_FEE) {
    lastConfig = await createProtocolFeeConfig(chain);
  } else if (hookType === HookType.INTERCHAIN_GAS_PAYMASTER) {
    lastConfig = await createIGPConfig(remotes);
  } else if (hookType === HookType.AGGREGATION) {
    lastConfig = await createAggregationConfig(chain, remotes);
  } else if (hookType === HookType.ROUTING) {
    lastConfig = await createRoutingConfig(chain, remotes);
  } else {
    throw new Error(`Invalid hook type: ${hookType}`);
  }
  return lastConfig;
}

export async function createProtocolFeeConfig(
  chain: ChainName,
): Promise<HookConfig> {
  const owner = await input({
    message: 'Enter owner address',
  });
  const ownerAddress = normalizeAddressEvm(owner);
  let beneficiary;
  let sameAsOwner = false;
  sameAsOwner = await confirm({
    message: 'Use this same address for the beneficiary?',
  });
  if (sameAsOwner) {
    beneficiary = ownerAddress;
  } else {
    beneficiary = await input({
      message: 'Enter beneficiary address',
    });
  }
  const beneficiaryAddress = normalizeAddressEvm(beneficiary);
  // TODO: input in gwei, wei, etc
  const maxProtocolFee = toWei(
    await input({
      message: `Enter max protocol fee ${nativeTokenAndDecimals(
        chain,
      )} e.g. 1.0)`,
    }),
  );
  const protocolFee = toWei(
    await input({
      message: `Enter protocol fee in ${nativeTokenAndDecimals(
        chain,
      )} e.g. 0.01)`,
    }),
  );
  if (BigNumberJs(protocolFee).gt(maxProtocolFee)) {
    errorRed('Protocol fee cannot be greater than max protocol fee');
    throw new Error('Invalid protocol fee');
  }

  return {
    type: HookType.PROTOCOL_FEE,
    maxProtocolFee: maxProtocolFee.toString(),
    protocolFee: protocolFee.toString(),
    beneficiary: beneficiaryAddress,
    owner: ownerAddress,
  };
}

export async function createIGPConfig(
  remotes: ChainName[],
): Promise<HookConfig> {
  const owner = await input({
    message: 'Enter owner address',
  });
  const ownerAddress = normalizeAddressEvm(owner);
  let beneficiary, oracleKey;
  let sameAsOwner = false;
  sameAsOwner = await confirm({
    message: 'Use this same address for the beneficiary and gasOracleKey?',
  });
  if (sameAsOwner) {
    beneficiary = ownerAddress;
    oracleKey = ownerAddress;
  } else {
    beneficiary = await input({
      message: 'Enter beneficiary address',
    });
    oracleKey = await input({
      message: 'Enter gasOracleKey address',
    });
  }
  const beneficiaryAddress = normalizeAddressEvm(beneficiary);
  const oracleKeyAddress = normalizeAddressEvm(oracleKey);
  const oracleConfigs: ChainMap<StorageGasOracleConfig> = {};
  const overheads: ChainMap<string> = {};
  for (const chain of remotes) {
    const overhead = await input({
      message: `Enter overhead for ${chain} (eg 75000)`,
    });
    overheads[chain] = overhead;

    const oracleConfig: StorageGasOracleConfig = {
      type: GasOracleContractType.StorageGasOracle,
    };

    const tokenExchangeRateInput = await input({
      message: `Enter token exchange rate ${chain} compared to the origin (out of 1e10) or press ENTER to use 1e10`,
    });
    const gasPriceInput = await input({
      message: `Enter gas price for ${chain} (eg 45 wei) or use the RPC gas price by pressing ENTER`,
    });

    if (tokenExchangeRateInput.trim() !== '') {
      oracleConfig.tokenExchangeRate = tokenExchangeRateInput;
    }
    if (gasPriceInput.trim() !== '') {
      oracleConfig.gasPrice = gasPriceInput;
    }
    oracleConfigs[chain] = oracleConfig;
  }
  return {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    beneficiary: beneficiaryAddress,
    owner: ownerAddress,
    oracleKey: oracleKeyAddress,
    oracleConfig: oracleConfigs,
    overhead: overheads,
  };
}

export async function createAggregationConfig(
  chain: ChainName,
  remotes: ChainName[],
): Promise<HookConfig> {
  const hooksNum = parseInt(
    await input({
      message: 'Enter the number of hooks to aggregate (number)',
    }),
    10,
  );
  const hooks: Array<HookConfig> = [];
  for (let i = 0; i < hooksNum; i++) {
    logBlue(`Creating hook ${i + 1} of ${hooksNum} ...`);
    hooks.push(await createHookConfig(chain, remotes));
  }
  return {
    type: HookType.AGGREGATION,
    hooks,
  };
}

export async function createRoutingConfig(
  origin: ChainName,
  remotes: ChainName[],
): Promise<HookConfig> {
  const owner = await input({
    message: 'Enter owner address',
  });
  const ownerAddress = owner;

  const domainsMap: ChainMap<HookConfig> = {};
  for (const chain of remotes) {
    await confirm({
      message: `You are about to configure hook for remote chain ${chain}. Continue?`,
    });
    const config = await createHookConfig(origin, remotes);
    domainsMap[chain] = config;
  }
  return {
    type: HookType.ROUTING,
    owner: ownerAddress,
    domains: domainsMap,
  };
}

function nativeTokenAndDecimals(chain: ChainName) {
  return `10^${
    chainMetadata[chain].nativeToken?.decimals ?? '18'
  } which you cannot exceed (in ${
    chainMetadata[chain].nativeToken?.symbol ?? 'eth'
  }`;
}
