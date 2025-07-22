import { ethers } from 'ethers';
import path from 'path';
import { $ } from 'zx';

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
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address, assert, inCIMode } from '@hyperlane-xyz/utils';

import { getContext } from '../../../context/context.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { KeyBoardKeys, TestPromptAction } from '../../commands/helpers.js';
import {
  ANVIL_KEY,
  REGISTRY_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

export const GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH = (
  originalDeployConfigPath: string,
  symbol: string,
): string => {
  const fileName = path.parse(originalDeployConfigPath).name;

  return getCombinedWarpRoutePath(symbol, [fileName]);
};

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
  const basePath = `${REGISTRY_PATH}/deployments/warp_routes/${warpRouteId}`;
  const updatedWarpConfigPath = `${basePath}-deploy.yaml`;
  const updatedWarpCorePath = `${basePath}-config.yaml`;
  writeYamlOrJson(updatedWarpConfigPath, warpConfig);
  writeYamlOrJson(updatedWarpCorePath, warpCoreConfig);

  return {
    warpDeployPath: updatedWarpConfigPath,
    warpCorePath: updatedWarpCorePath,
  };
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

export async function hyperlaneSubmit({
  transactionsPath,
  strategyPath,
  hypKey,
}: {
  transactionsPath: string;
  strategyPath?: string;
  hypKey?: string;
}) {
  return $`${
    hypKey ? ['HYP_KEY=' + hypKey] : []
  } ${localTestRunCmdPrefix()} hyperlane submit \
        --registry ${REGISTRY_PATH} \
        --transactions ${transactionsPath} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        ${strategyPath ? ['--strategy', strategyPath] : []} \
        --yes`;
}
