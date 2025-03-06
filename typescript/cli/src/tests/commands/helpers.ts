import { ethers } from 'ethers';
import { $, ProcessOutput, ProcessPromise } from 'zx';

import {
  ERC20Test,
  ERC20Test__factory,
  ERC4626Test__factory,
} from '@hyperlane-xyz/core';
import {
  ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  HypTokenRouterConfig,
  WarpCoreConfig,
  WarpCoreConfigSchema,
} from '@hyperlane-xyz/sdk';
import { Address, sleep } from '@hyperlane-xyz/utils';

import { getContext } from '../../context/context.js';
import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';

import { hyperlaneCoreDeploy } from './core.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpSendRelay,
  readWarpConfig,
} from './warp.js';

export const E2E_TEST_CONFIGS_PATH = './test-configs';
export const REGISTRY_PATH = `${E2E_TEST_CONFIGS_PATH}/anvil`;
export const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh

export const ANVIL_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const E2E_TEST_BURN_ADDRESS =
  '0x0000000000000000000000000000000000000001';

export const CHAIN_NAME_2 = 'anvil2';
export const CHAIN_NAME_3 = 'anvil3';

export const EXAMPLES_PATH = './examples';
export const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;
export const CORE_CONFIG_PATH_2 = `${TEMP_PATH}/${CHAIN_NAME_2}/core-config.yaml`;
export const CORE_READ_CONFIG_PATH_2 = `${TEMP_PATH}/${CHAIN_NAME_2}/core-config-read.yaml`;
export const CHAIN_2_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_2}/metadata.yaml`;
export const CHAIN_3_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_3}/metadata.yaml`;

export const WARP_CONFIG_PATH_EXAMPLE = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;
export const WARP_CONFIG_PATH_2 = `${TEMP_PATH}/${CHAIN_NAME_2}/warp-route-deployment-anvil2.yaml`;
export const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/warp-route-deployment.yaml`;
export const WARP_CORE_CONFIG_PATH_2 = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil2-config.yaml`;

export function getCombinedWarpRoutePath(
  tokenSymbol: string,
  chains: string[],
): string {
  return `${REGISTRY_PATH}/deployments/warp_routes/${createWarpRouteConfigId(
    tokenSymbol.toUpperCase(),
    chains,
  )}-config.yaml`;
}

export const DEFAULT_E2E_TEST_TIMEOUT = 100_000; // Long timeout since these tests can take a while

export enum KeyBoardKeys {
  ARROW_DOWN = '\x1b[B',
  ARROW_UP = '\x1b[A',
  ENTER = '\n',
  TAB = '\t',
}

export async function asyncStreamInputWrite(
  stream: NodeJS.WritableStream,
  data: string | Buffer,
): Promise<void> {
  stream.write(data);
  // Adding a slight delay to allow the buffer to update the output
  await sleep(500);
}

export type TestPromptAction = {
  check: (currentOutput: string) => boolean;
  input: string;
};

/**
 * Takes a {@link ProcessPromise} and a list of inputs that will be supplied
 * in the provided order when the check in the {@link TestPromptAction} matches the output
 * of the {@link ProcessPromise}.
 */
export async function handlePrompts(
  processPromise: Readonly<ProcessPromise>,
  actions: TestPromptAction[],
): Promise<ProcessOutput> {
  let expectedStep = 0;
  for await (const out of processPromise.stdout) {
    const currentLine: string = out.toString();

    const currentAction = actions[expectedStep];
    if (currentAction && currentAction.check(currentLine)) {
      // Select mainnet chains
      await asyncStreamInputWrite(processPromise.stdin, currentAction.input);
      expectedStep++;
    }
  }

  return processPromise;
}

export const SELECT_ANVIL_2_FROM_MULTICHAIN_PICKER = `${KeyBoardKeys.ARROW_DOWN.repeat(
  3,
)}${KeyBoardKeys.TAB}`;

export const SELECT_ANVIL_3_AFTER_ANVIL_2_FROM_MULTICHAIN_PICKER = `${KeyBoardKeys.ARROW_DOWN.repeat(
  2,
)}${KeyBoardKeys.TAB}`;

export const SELECT_MAINNET_CHAIN_TYPE_STEP: TestPromptAction = {
  check: (currentOutput: string) =>
    currentOutput.includes('Select network type'),
  // Select mainnet chains
  input: KeyBoardKeys.ENTER,
};

export const SELECT_ANVIL_2_AND_ANVIL_3_STEPS: ReadonlyArray<TestPromptAction> =
  [
    {
      check: (currentOutput: string) =>
        currentOutput.includes('--Mainnet Chains--'),
      input: `${SELECT_ANVIL_2_FROM_MULTICHAIN_PICKER}`,
    },
    {
      check: (currentOutput: string) =>
        currentOutput.includes('--Mainnet Chains--'),
      input: `${SELECT_ANVIL_3_AFTER_ANVIL_2_FROM_MULTICHAIN_PICKER}${KeyBoardKeys.ENTER}`,
    },
  ];

export const CONFIRM_DETECTED_OWNER_STEP: Readonly<TestPromptAction> = {
  check: (currentOutput: string) =>
    currentOutput.includes('Detected owner address as'),
  input: KeyBoardKeys.ENTER,
};

export const SETUP_CHAIN_SIGNERS_MANUALLY_STEPS: ReadonlyArray<TestPromptAction> =
  [
    {
      check: (currentOutput) =>
        currentOutput.includes('Please enter the private key for chain'),
      input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
    },
    {
      check: (currentOutput) =>
        currentOutput.includes('Please enter the private key for chain'),
      input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
    },
    {
      check: (currentOutput) =>
        currentOutput.includes('Please enter the private key for chain'),
      input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
    },
  ];

/**
 * Retrieves the deployed Warp address from the Warp core config.
 */
export function getDeployedWarpAddress(chain: string, warpCorePath: string) {
  const warpCoreConfig: WarpCoreConfig = readYamlOrJson(warpCorePath);
  WarpCoreConfigSchema.parse(warpCoreConfig);
  return warpCoreConfig.tokens.find((t) => t.chainName === chain)!
    .addressOrDenom;
}

/**
 * Updates the owner of the Warp route deployment config, and then output to a file
 */
export async function updateWarpOwnerConfig(
  chain: string,
  owner: Address,
  warpCorePath: string,
  warpDeployPath: string,
): Promise<string> {
  const warpDeployConfig = await readWarpConfig(
    chain,
    warpCorePath,
    warpDeployPath,
  );
  warpDeployConfig[chain].owner = owner;
  await writeYamlOrJson(warpDeployPath, warpDeployConfig);

  return warpDeployPath;
}

/**
 * Updates the Warp route deployment configuration with a new owner, and then applies the changes.
 */
export async function updateOwner(
  owner: Address,
  chain: string,
  warpConfigPath: string,
  warpCoreConfigPath: string,
) {
  await updateWarpOwnerConfig(chain, owner, warpCoreConfigPath, warpConfigPath);
  return hyperlaneWarpApply(warpConfigPath, warpCoreConfigPath);
}

/**
 * Extends the Warp route deployment with a new warp config
 */
export async function extendWarpConfig(params: {
  chain: string;
  chainToExtend: string;
  extendedConfig: HypTokenRouterConfig;
  warpCorePath: string;
  warpDeployPath: string;
  strategyUrl?: string;
}): Promise<string> {
  const {
    chain,
    chainToExtend,
    extendedConfig,
    warpCorePath,
    warpDeployPath,
    strategyUrl,
  } = params;
  const warpDeployConfig = await readWarpConfig(
    chain,
    warpCorePath,
    warpDeployPath,
  );
  warpDeployConfig[chainToExtend] = extendedConfig;
  writeYamlOrJson(warpDeployPath, warpDeployConfig);
  await hyperlaneWarpApply(warpDeployPath, warpCorePath, strategyUrl);

  return warpDeployPath;
}

/**
 * Deploys new core contracts on the specified chain if it doesn't already exist, and returns the chain addresses.
 */
export async function deployOrUseExistingCore(
  chain: string,
  coreInputPath: string,
  key: string,
) {
  const { registry } = await getContext({
    registryUris: [REGISTRY_PATH],
    key,
  });
  const addresses = (await registry.getChainAddresses(chain)) as ChainAddresses;

  if (!addresses) {
    await hyperlaneCoreDeploy(chain, coreInputPath);
    return deployOrUseExistingCore(chain, coreInputPath, key);
  }

  return addresses;
}

export async function getDomainId(
  chainName: string,
  key: string,
): Promise<string> {
  const { registry } = await getContext({
    registryUris: [REGISTRY_PATH],
    key,
  });
  const chainMetadata = await registry.getChainMetadata(chainName);
  return String(chainMetadata?.domainId);
}

export async function deployToken(
  privateKey: string,
  chain: string,
  decimals = 18,
  symbol = 'TOKEN',
): Promise<ERC20Test> {
  const { multiProvider } = await getContext({
    registryUris: [REGISTRY_PATH],
    key: privateKey,
  });

  // Future works: make signer compatible with protocol/chain stack
  multiProvider.setSigner(chain, new ethers.Wallet(privateKey));

  const token = await new ERC20Test__factory(
    multiProvider.getSigner(chain),
  ).deploy(
    'token',
    symbol.toLocaleUpperCase(),
    '100000000000000000000',
    decimals,
  );
  await token.deployed();

  return token;
}

export async function deploy4626Vault(
  privateKey: string,
  chain: string,
  tokenAddress: string,
) {
  const { multiProvider } = await getContext({
    registryUris: [REGISTRY_PATH],
    key: privateKey,
  });

  // Future works: make signer compatible with protocol/chain stack
  multiProvider.setSigner(chain, new ethers.Wallet(privateKey));

  const vault = await new ERC4626Test__factory(
    multiProvider.getSigner(chain),
  ).deploy(tokenAddress, 'VAULT', 'VAULT');
  await vault.deployed();

  return vault;
}

/**
 * Performs a round-trip warp relay between two chains using the specified warp core config.
 *
 * @param chain1 - The first chain to send the warp relay from.
 * @param chain2 - The second chain to send the warp relay to and back from.
 * @param warpCoreConfigPath - The path to the warp core config file.
 * @returns A promise that resolves when the round-trip warp relay is complete.
 */
export async function sendWarpRouteMessageRoundTrip(
  chain1: string,
  chain2: string,
  warpCoreConfigPath: string,
) {
  await hyperlaneWarpSendRelay(chain1, chain2, warpCoreConfigPath);
  return hyperlaneWarpSendRelay(chain2, chain1, warpCoreConfigPath);
}

export async function hyperlaneSendMessage(
  origin: string,
  destination: string,
) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane send message \
        --registry ${REGISTRY_PATH} \
        --origin ${origin} \
        --destination ${destination} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}

export function hyperlaneRelayer(chains: string[], warp?: string) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane relayer \
        --registry ${REGISTRY_PATH} \
        --chains ${chains.join(',')} \
        --warp ${warp ?? ''} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}
