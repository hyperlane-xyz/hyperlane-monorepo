import { JsonRpcProvider } from '@ethersproject/providers';
import { Wallet, ethers } from 'ethers';
import path from 'path';
import { $, ProcessOutput, ProcessPromise } from 'zx';

import {
  ERC20Test,
  ERC20Test__factory,
  ERC4626Test__factory,
  XERC20LockboxTest,
  XERC20LockboxTest__factory,
  XERC20VSTest,
  XERC20VSTest__factory,
} from '@hyperlane-xyz/core';
import {
  ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  HypTokenRouterConfig,
  TokenType,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address, assert, inCIMode, sleep } from '@hyperlane-xyz/utils';

import { getContext } from '../../context/context.js';
import { CommandContext } from '../../context/types.js';
import { extendWarpRoute as extendWarpRouteWithoutApplyTransactions } from '../../deploy/warp.js';
import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';

import { hyperlaneCoreDeploy } from './core.js';
import {
  hyperlaneWarpApplyRaw,
  hyperlaneWarpSendRelay,
  readWarpConfig,
} from './warp.js';

export const E2E_TEST_CONFIGS_PATH = './test-configs';
export const REGISTRY_PATH = `${E2E_TEST_CONFIGS_PATH}/anvil`;
export const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh

export const ANVIL_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const ANVIL_DEPLOYER_ADDRESS =
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const E2E_TEST_BURN_ADDRESS =
  '0x0000000000000000000000000000000000000001';
export const COINGECKO_API_KEY = 'CG-Gmk12Pz3A4L9qR5XtV7Kd8N3';

export const CHAIN_NAME_2 = 'anvil2';
export const CHAIN_NAME_3 = 'anvil3';
export const CHAIN_NAME_4 = 'anvil4';

export const EXAMPLES_PATH = './examples';
export const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;
export const CORE_CONFIG_PATH_2 = `${TEMP_PATH}/${CHAIN_NAME_2}/core-config.yaml`;
export const CORE_READ_CONFIG_PATH_2 = `${TEMP_PATH}/${CHAIN_NAME_2}/core-config-read.yaml`;
export const CHAIN_2_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_2}/metadata.yaml`;
export const CHAIN_3_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_3}/metadata.yaml`;
export const CHAIN_4_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_4}/metadata.yaml`;

export const WARP_CONFIG_PATH_EXAMPLE = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;
export const WARP_CONFIG_PATH_2 = `${TEMP_PATH}/${CHAIN_NAME_2}/warp-route-deployment-anvil2.yaml`;
export const WARP_DEPLOY_DEFAULT_FILE_NAME = `warp-route-deployment`;
export const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/${WARP_DEPLOY_DEFAULT_FILE_NAME}.yaml`;
export const WARP_DEPLOY_2_ID = 'ETH/anvil2';
export const E2E_TEST_WARP_ROUTE_REGISTRY_PATH = `${REGISTRY_PATH}/deployments/warp_routes`;
export const WARP_CORE_CONFIG_PATH_2 = getCombinedWarpRoutePath('ETH', [
  CHAIN_NAME_2,
]);

export const GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH = (
  originalDeployConfigPath: string,
  symbol: string,
): string => {
  const fileName = path.parse(originalDeployConfigPath).name;

  return getCombinedWarpRoutePath(symbol, [fileName]);
};

export const REBALANCER_CONFIG_PATH = `${TEMP_PATH}/rebalancer-config.json`;

export function getCombinedWarpRoutePath(
  tokenSymbol: string,
  chains: string[],
): string {
  return `${E2E_TEST_WARP_ROUTE_REGISTRY_PATH}/${createWarpRouteConfigId(
    tokenSymbol.toUpperCase(),
    chains.sort().join('-'),
  )}-config.yaml`;
}

export function exportWarpConfigsToFilePaths({
  warpRouteId,
  warpConfig,
  warpCoreConfig,
}: {
  warpRouteId: string;
  warpConfig: WarpRouteDeployConfig;
  warpCoreConfig: WarpCoreConfig;
}): {
  warpDeployPath: string;
  warpCorePath: string;
} {
  const basePath = `${E2E_TEST_WARP_ROUTE_REGISTRY_PATH}/${warpRouteId}`;
  const updatedWarpConfigPath = `${basePath}-deploy.yaml`;
  const updatedWarpCorePath = `${basePath}-config.yaml`;
  writeYamlOrJson(updatedWarpConfigPath, warpConfig);
  writeYamlOrJson(updatedWarpCorePath, warpCoreConfig);

  return {
    warpDeployPath: updatedWarpConfigPath,
    warpCorePath: updatedWarpCorePath,
  };
}

export const DEFAULT_E2E_TEST_TIMEOUT = 100_000; // Long timeout since these tests can take a while

export enum KeyBoardKeys {
  ARROW_DOWN = '\x1b[B',
  ARROW_UP = '\x1b[A',
  ENTER = '\n',
  TAB = '\t',
  ACCEPT = 'y',
  DECLINE = 'n',
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

export const SELECT_MAINNET_CHAINS_ANVIL_2_STEP: TestPromptAction = {
  check: (currentOutput: string) =>
    currentOutput.includes('--Mainnet Chains--'),
  // Scroll down through the mainnet chains list and select anvil2
  input: `${SELECT_ANVIL_2_FROM_MULTICHAIN_PICKER}${KeyBoardKeys.ENTER}`,
};

export const CONFIRM_CHAIN_SELECTION_STEP: TestPromptAction = {
  check: (currentOutput: string) =>
    currentOutput.includes('Is this chain selection correct?'),
  input: `${KeyBoardKeys.ENTER}`,
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
    currentOutput.includes('Using owner address as'),
  input: KeyBoardKeys.ENTER,
};

export const CONFIRM_DETECTED_PROXY_ADMIN_STEP: Readonly<TestPromptAction> = {
  check: (currentOutput: string) =>
    currentOutput.includes('Use an existing Proxy Admin contract'),
  input: `${KeyBoardKeys.DECLINE}${KeyBoardKeys.ENTER}`,
};

export const CONFIRM_DETECTED_TRUSTED_ISM_STEP: Readonly<TestPromptAction> = {
  check: (currentOutput: string) =>
    currentOutput.includes('Do you want to use a trusted ISM for warp route?'),
  input: `${KeyBoardKeys.DECLINE}${KeyBoardKeys.ENTER}`,
};

//

export const SETUP_CHAIN_SIGNER_MANUALLY_STEP: Readonly<TestPromptAction> = {
  check: (currentOutput) =>
    currentOutput.includes('Please enter the private key for chain'),
  input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
};

/**
 * Retrieves the token address for a given chain from a warp config object.
 * @param config The warp core config object.
 * @param chainName The name of the chain.
 * @returns The address of the token contract.
 */
export function getTokenAddressFromWarpConfig(
  config: WarpCoreConfig,
  chainName: string,
): Address {
  const tokenConfig = config.tokens.find((t) => t.chainName === chainName);
  if (!tokenConfig || !tokenConfig.addressOrDenom) {
    throw new Error(`Could not find token config for ${chainName}`);
  }
  return tokenConfig.addressOrDenom;
}

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
 * Extends the Warp route deployment with a new warp config
 */
export async function extendWarpConfig(params: {
  chain: string;
  chainToExtend: string;
  extendedConfig: HypTokenRouterConfig;
  warpCorePath: string;
  warpDeployPath: string;
  strategyUrl?: string;
  warpRouteId?: string;
}): Promise<string> {
  const {
    chain,
    chainToExtend,
    extendedConfig,
    warpCorePath,
    warpDeployPath,
    strategyUrl,
    warpRouteId,
  } = params;
  const warpDeployConfig = await readWarpConfig(
    chain,
    warpCorePath,
    warpDeployPath,
  );
  warpDeployConfig[chainToExtend] = extendedConfig;
  // Remove remoteRouters and destinationGas as they are written in readWarpConfig
  delete warpDeployConfig[chain].remoteRouters;
  delete warpDeployConfig[chain].destinationGas;

  writeYamlOrJson(warpDeployPath, warpDeployConfig);
  await hyperlaneWarpApplyRaw({
    warpDeployPath,
    warpCorePath,
    strategyUrl,
    warpRouteId,
  });

  return warpDeployPath;
}

export async function resetAnvilFork(
  provider: JsonRpcProvider,
  stateId: string,
): Promise<string> {
  await provider.send('evm_revert', [stateId]);
  const newStateId = await provider.send('evm_snapshot', []);

  return newStateId;
}

export async function resetAnvilForksBatch(
  configs: [JsonRpcProvider, string][],
): Promise<string[]> {
  return Promise.all(
    configs.map(([provider, stateId]) => resetAnvilFork(provider, stateId)),
  );
}

/**
 * Sets up an incomplete warp route extension for testing purposes.
 *
 * This function creates a new warp route configuration for the second chain.
 */
export async function setupIncompleteWarpRouteExtension(
  chain2Addresses: ChainAddresses,
): Promise<{
  chain2DomainId: string;
  chain3DomainId: string;
  warpConfigPath: string;
  configToExtend: HypTokenRouterConfig;
  context: CommandContext;
  combinedWarpCorePath: string;
}> {
  const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

  const chain2DomainId = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
  const chain3DomainId = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);

  const configToExtend: HypTokenRouterConfig = {
    decimals: 18,
    mailbox: chain2Addresses!.mailbox,
    name: 'Ether',
    owner: new Wallet(ANVIL_KEY).address,
    symbol: 'ETH',
    type: TokenType.native,
  };

  const context = await getContext({
    registryUris: [REGISTRY_PATH],
    key: ANVIL_KEY,
  });

  const warpCoreConfig = readYamlOrJson(
    WARP_CORE_CONFIG_PATH_2,
  ) as WarpCoreConfig;
  const warpDeployConfig = await readWarpConfig(
    CHAIN_NAME_2,
    WARP_CORE_CONFIG_PATH_2,
    warpConfigPath,
  );

  warpDeployConfig[CHAIN_NAME_3] = configToExtend;

  const signer2 = new Wallet(
    ANVIL_KEY,
    context.multiProvider.getProvider(CHAIN_NAME_2),
  );
  const signer3 = new Wallet(
    ANVIL_KEY,
    context.multiProvider.getProvider(CHAIN_NAME_3),
  );
  context.multiProvider.setSigner(CHAIN_NAME_2, signer2);
  context.multiProvider.setSigner(CHAIN_NAME_3, signer3);

  await extendWarpRouteWithoutApplyTransactions(
    {
      context: {
        ...context,
        signer: signer3,
        key: ANVIL_KEY,
      },
      warpCoreConfig,
      warpDeployConfig,
      receiptsDir: TEMP_PATH,
    },
    {},
    warpCoreConfig,
  );

  const combinedWarpCorePath = getCombinedWarpRoutePath('ETH', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);

  return {
    chain2DomainId,
    chain3DomainId,
    warpConfigPath,
    configToExtend,
    context,
    combinedWarpCorePath,
  };
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
  name = 'token',
): Promise<ERC20Test> {
  const { multiProvider } = await getContext({
    registryUris: [REGISTRY_PATH],
    key: privateKey,
  });

  // Future works: make signer compatible with protocol/chain stack
  multiProvider.setSigner(chain, new ethers.Wallet(privateKey));

  const token = await new ERC20Test__factory(
    multiProvider.getSigner(chain),
  ).deploy(name, symbol.toLocaleUpperCase(), '100000000000000000000', decimals);
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

export async function deployXERC20VSToken(
  privateKey: string,
  chain: string,
  decimals = 18,
  symbol = 'TOKEN',
): Promise<XERC20VSTest> {
  const { multiProvider } = await getContext({
    registryUris: [REGISTRY_PATH],
    key: privateKey,
  });

  // Future works: make signer compatible with protocol/chain stack
  multiProvider.setSigner(chain, new ethers.Wallet(privateKey));

  const token = await new XERC20VSTest__factory(
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

export async function deployXERC20LockboxToken(
  privateKey: string,
  chain: string,
  token: ERC20Test,
): Promise<XERC20LockboxTest> {
  const { multiProvider } = await getContext({
    registryUris: [REGISTRY_PATH],
    key: privateKey,
  });

  // Future works: make signer compatible with protocol/chain stack
  multiProvider.setSigner(chain, new ethers.Wallet(privateKey));

  const [tokenSymbol, tokenName, tokenDecimals, tokenTotalSupply] =
    await Promise.all([
      token.symbol(),
      token.name(),
      token.decimals(),
      token.totalSupply(),
    ]);

  const lockboxToken = await new XERC20LockboxTest__factory(
    multiProvider.getSigner(chain),
  ).deploy(
    tokenName,
    tokenSymbol.toLocaleUpperCase(),
    tokenTotalSupply,
    tokenDecimals,
  );
  await lockboxToken.deployed();

  return lockboxToken;
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

// Verifies if the IS_CI var is set and generates the correct prefix for running the command
// in the current env
export function localTestRunCmdPrefix() {
  return inCIMode() ? [] : ['yarn', 'workspace', '@hyperlane-xyz/cli', 'run'];
}

export async function hyperlaneSendMessage(
  origin: string,
  destination: string,
) {
  return $`${localTestRunCmdPrefix()} hyperlane send message \
        --registry ${REGISTRY_PATH} \
        --origin ${origin} \
        --destination ${destination} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}

export function hyperlaneRelayer(chains: string[], warp?: string) {
  return $`${localTestRunCmdPrefix()} hyperlane relayer \
        --registry ${REGISTRY_PATH} \
        --chains ${chains.join(',')} \
        --warp ${warp ?? ''} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}

export function createSnapshot(rpcUrl: string) {
  return snapshotBaseCall<string>(rpcUrl, 'evm_snapshot', []);
}

export async function restoreSnapshot(
  rpcUrl: string,
  snapshotId: string,
): Promise<void> {
  const result = await snapshotBaseCall<boolean>(rpcUrl, 'evm_revert', [
    snapshotId,
  ]);
  assert(result, 'Failed to restore snapshot');
}

async function snapshotBaseCall<T>(
  rpcUrl: string,
  method: string,
  params: any[],
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: 1337,
      jsonrpc: '2.0',
      method,
      params,
    }),
  });
  const { result } = await response.json();
  return result;
}
