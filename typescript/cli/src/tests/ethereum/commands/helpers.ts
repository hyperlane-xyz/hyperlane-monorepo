import { generateKeyPairSync } from 'crypto';
import { ethers } from 'ethers';
import http from 'http';
import { type IncomingMessage, type ServerResponse } from 'http';
import path from 'path';
import { $, type ProcessPromise } from 'zx';

import {
  type AbstractCcipReadIsm,
  AbstractCcipReadIsm__factory,
  type ERC20Test,
  ERC20Test__factory,
  ERC4626Test__factory,
  type FiatTokenTest,
  FiatTokenTest__factory,
  type MockEverclearAdapter,
  MockEverclearAdapter__factory,
  TestCcipReadIsm__factory,
  type XERC20LockboxTest,
  XERC20LockboxTest__factory,
  type XERC20VSTest,
  XERC20VSTest__factory,
} from '@hyperlane-xyz/core';
import { type TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';
import {
  type MultiProvider,
  type WarpCoreConfig,
  WarpCoreConfigSchema,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  ProtocolType,
  assert,
  ensure0x,
  inCIMode,
} from '@hyperlane-xyz/utils';

import { TronWallet } from '@hyperlane-xyz/tron-sdk';

import { getContext } from '../../../context/context.js';
import {
  isFile,
  readYamlOrJson,
  writeYamlOrJson,
} from '../../../utils/files.js';
import { KeyBoardKeys, type TestPromptAction } from '../../commands/helpers.js';
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
  registryPath = REGISTRY_PATH,
}: {
  warpRouteId: string;
  warpConfig: WarpRouteDeployConfig;
  warpCoreConfig: WarpCoreConfig;
  registryPath?: string;
}): {
  warpDeployPath: string;
  warpCorePath: string;
} {
  const basePath = `${registryPath}/deployments/warp_routes/${warpRouteId}`;
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
  assert(isFile(warpCorePath), `File doesn't exist at ${warpCorePath}`);
  const warpCoreConfig: WarpCoreConfig = readYamlOrJson(warpCorePath);
  WarpCoreConfigSchema.parse(warpCoreConfig);
  const tokenConfig = warpCoreConfig.tokens.find(
    (token) => token.chainName === chain,
  );
  if (!tokenConfig?.addressOrDenom) {
    throw new Error(`Could not find token config for ${chain}`);
  }
  return tokenConfig.addressOrDenom;
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

/**
 * Set the appropriate signer type on the MultiProvider based on the chain's
 * technical stack (TronWallet for Tron chains, ethers.Wallet otherwise).
 */
function setSignerForChain(
  multiProvider: MultiProvider,
  chain: string,
  privateKey: string,
): void {
  const key = ensure0x(privateKey);
  const { protocol, rpcUrls } = multiProvider.getChainMetadata(chain);
  if (protocol === ProtocolType.Tron) {
    assert(rpcUrls?.length, `No rpcUrls configured for chain ${chain}`);
    multiProvider.setSigner(chain, new TronWallet(key, rpcUrls[0].http));
  } else {
    multiProvider.setSigner(chain, new ethers.Wallet(key));
  }
}

export async function deployToken(
  privateKey: string,
  chain: string,
  decimals = 18,
  symbol = 'TOKEN',
  name = 'token',
  registryPath = REGISTRY_PATH,
): Promise<ERC20Test> {
  const { multiProvider } = await getContext({
    registryUris: [registryPath],
    key: privateKey,
  });

  setSignerForChain(multiProvider, chain, privateKey);

  return multiProvider.handleDeploy(chain, new ERC20Test__factory(), [
    name,
    symbol.toLocaleUpperCase(),
    '100000000000000000000',
    decimals,
  ]);
}

export async function deployFiatToken(
  privateKey: string,
  chain: string,
  decimals = 18,
  symbol = 'FIAT TOKEN',
  name = 'fiat token',
): Promise<FiatTokenTest> {
  const { multiProvider } = await getContext({
    registryUris: [REGISTRY_PATH],
    key: privateKey,
  });

  setSignerForChain(multiProvider, chain, privateKey);

  return multiProvider.handleDeploy(chain, new FiatTokenTest__factory(), [
    name,
    symbol.toLocaleUpperCase(),
    '100000000000000000000',
    decimals,
  ]);
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

  setSignerForChain(multiProvider, chain, privateKey);

  return multiProvider.handleDeploy(chain, new ERC4626Test__factory(), [
    tokenAddress,
    'VAULT',
    'VAULT',
  ]);
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

  setSignerForChain(multiProvider, chain, privateKey);

  return multiProvider.handleDeploy(chain, new XERC20VSTest__factory(), [
    'token',
    symbol.toLocaleUpperCase(),
    '100000000000000000000',
    decimals,
  ]);
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

  setSignerForChain(multiProvider, chain, privateKey);

  const [tokenSymbol, tokenName, tokenDecimals, tokenTotalSupply] =
    await Promise.all([
      token.symbol(),
      token.name(),
      token.decimals(),
      token.totalSupply(),
    ]);

  return multiProvider.handleDeploy(chain, new XERC20LockboxTest__factory(), [
    tokenName,
    tokenSymbol.toLocaleUpperCase(),
    tokenTotalSupply,
    tokenDecimals,
  ]);
}

export async function deployTestOffchainLookupISM(
  privateKey: string,
  chain: string,
  urls: string[] = [],
  registryPath: string = REGISTRY_PATH,
): Promise<AbstractCcipReadIsm> {
  const { multiProvider } = await getContext({
    registryUris: [registryPath],
    key: privateKey,
  });

  setSignerForChain(multiProvider, chain, privateKey);

  const testIsm = await multiProvider.handleDeploy(
    chain,
    new TestCcipReadIsm__factory(),
    [urls],
  );

  return AbstractCcipReadIsm__factory.connect(
    testIsm.address,
    multiProvider.getSigner(chain),
  );
}

export async function deployEverclearBridgeAdapter(
  privateKey: string,
  chain: string,
  registryPath: string,
): Promise<MockEverclearAdapter> {
  const { multiProvider } = await getContext({
    registryUris: [registryPath],
    key: privateKey,
  });

  setSignerForChain(multiProvider, chain, privateKey);

  return multiProvider.handleDeploy(
    chain,
    new MockEverclearAdapter__factory(),
    [],
  );
}

// Verifies if the IS_CI var is set and generates the correct prefix for running the command
// in the current env
export function localTestRunCmdPrefix() {
  return inCIMode() ? [] : ['pnpm', '--filter', '@hyperlane-xyz/cli', 'run'];
}

export async function hyperlaneSendMessage(
  origin: string,
  destination: string,
  { quick = false }: { quick?: boolean } = {},
) {
  return $`${localTestRunCmdPrefix()} hyperlane send message \
        --registry ${REGISTRY_PATH} \
        --origin ${origin} \
        --destination ${destination} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        ${quick ? ['--quick'] : []} \
        --yes`;
}

export function hyperlaneStatus({
  origin,
  messageId,
  dispatchTx,
  relay,
  key,
  quick,
}: {
  origin: string;
  messageId?: string;
  dispatchTx?: string;
  relay?: boolean;
  key?: string;
  quick?: boolean;
}) {
  return $`${localTestRunCmdPrefix()} hyperlane status \
        --registry ${REGISTRY_PATH} \
        --origin ${origin} \
        ${messageId ? ['--id', messageId] : []} \
        ${dispatchTx ? ['--dispatchTx', dispatchTx] : []} \
        ${relay ? ['--relay'] : []} \
        ${key ? ['--key', key] : []} \
        ${quick ? ['--quick'] : []} \
        --verbosity debug \
        --yes`;
}

export function hyperlaneRelayer(chains: string[], warpRouteId?: string) {
  return $`${localTestRunCmdPrefix()} hyperlane relayer \
        --registry ${REGISTRY_PATH} \
        ${chains.flatMap((c) => ['--chains', c])} \
        ${warpRouteId ? ['--warp-route-id', warpRouteId] : []} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}

/**
 * True for the two ways a relayer process can already be gone by the time it is
 * signalled: zx refusing to signal a settled process, and the OS reporting no
 * such process.
 */
function isAlreadyExitedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes('Too late to kill the process')) return true;
  return 'code' in error && error.code === 'ESRCH';
}

/**
 * Stops a relayer started with hyperlaneRelayer. Only an already-exited process
 * is tolerated: any other failure means the relayer may still be running and
 * would poison the rest of the suite, so it is surfaced.
 */
export async function stopRelayer(relayer: ProcessPromise): Promise<void> {
  try {
    await relayer.kill('SIGINT');
  } catch (error) {
    if (!isAlreadyExitedError(error)) throw error;
  }
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
  signerConfigPath,
  receiptsPath,
  hypKey,
}: {
  transactionsPath: string;
  strategyPath?: string;
  signerConfigPath?: string;
  receiptsPath?: string;
  hypKey?: string;
}) {
  return $`${
    hypKey ? ['HYP_KEY=' + hypKey] : []
  } ${localTestRunCmdPrefix()} hyperlane submit \
        --registry ${REGISTRY_PATH} \
        --transactions ${transactionsPath} \
        ${
          signerConfigPath
            ? ['--signer-config', signerConfigPath]
            : ['--key', ANVIL_KEY]
        } \
        --verbosity debug \
        ${strategyPath ? ['--strategy', strategyPath] : []} \
        ${receiptsPath ? ['--receipts', receiptsPath] : []} \
        --yes`;
}

export async function startMockTurnkeyApi(wallet: ethers.Wallet): Promise<{
  url: string;
  apiKey: { apiPublicKey: string; apiPrivateKey: string };
  close: () => Promise<void>;
}> {
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = keyPair.privateKey.export({ format: 'jwk' });
  assert(jwk.x && jwk.y && jwk.d, 'Expected complete P-256 JWK');
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  assert(y.length > 0, 'Expected P-256 public key bytes');
  const apiKey = {
    apiPublicKey: `${y[y.length - 1] & 1 ? '03' : '02'}${x.toString('hex')}`,
    apiPrivateKey: Buffer.from(jwk.d, 'base64url').toString('hex'),
  };

  const server = http.createServer((request, response) => {
    void handleTurnkeyRequest(wallet, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'Expected TCP server address');

  return {
    url: `http://127.0.0.1:${address.port}`,
    apiKey,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function handleTurnkeyRequest(
  wallet: ethers.Wallet,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (request.url === '/public/v1/query/whoami') {
      sendJson(response, { organizationId: 'test-organization' });
      return;
    }
    if (request.url === '/public/v1/submit/sign_transaction') {
      const body: unknown = JSON.parse(await readRequestBody(request));
      assert(isRecord(body), 'Expected request body');
      const parameters = body.parameters;
      assert(isRecord(parameters), 'Expected request parameters');
      const unsignedTransaction = parameters.unsignedTransaction;
      assert(
        typeof unsignedTransaction === 'string',
        'Expected unsigned transaction',
      );
      const signedTransaction = await wallet.signTransaction(
        parseUnsignedTransaction(`0x${unsignedTransaction}`),
      );
      sendJson(response, {
        activity: {
          id: 'test-activity',
          status: 'ACTIVITY_STATUS_COMPLETED',
          result: { signTransactionResult: { signedTransaction } },
        },
      });
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : '');
  }
}

function parseUnsignedTransaction(
  serialized: string,
): ethers.providers.TransactionRequest {
  const parsed = ethers.utils.parseTransaction(serialized);
  return {
    to: parsed.to ?? undefined,
    nonce: parsed.nonce,
    gasLimit: parsed.gasLimit,
    gasPrice: parsed.gasPrice ?? undefined,
    data: parsed.data,
    value: parsed.value,
    chainId: parsed.chainId,
    type: parsed.type ?? undefined,
    maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? undefined,
    maxFeePerGas: parsed.maxFeePerGas ?? undefined,
    accessList: parsed.accessList ?? undefined,
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Creates a mock Safe Transaction Service API server.
 */
export async function createMockSafeApi(
  metadata: TestChainMetadata,
  safeAddress: Address,
  safeOwner: Address,
  nonce: number,
): Promise<{
  server: ReturnType<typeof http.createServer>;
  url: string;
  close: () => Promise<void>;
}> {
  const serviceUrl = metadata.gnosisSafeTransactionServiceUrl;
  assert(
    serviceUrl,
    `Safe service url is required for running mock SAFE service for chain ${metadata.name}`,
  );
  const port = new URL(serviceUrl).port;

  // Send a JSON body with an explicit Content-Length. The Safe SDK's HTTP
  // client (node-fetch via @safe-global/api-kit) rejects responses without
  // proper framing as "Premature close", which would make getSafeInfo retry
  // until the test times out.
  const sendJson = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
  ) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  const server = http.createServer((req, res) => {
    const url = req.url || '';
    console.info('Mock safe API received request', req.method, url);

    if (req.method === 'POST' && url.includes('/multisig-transactions')) {
      // Mock POST /api/v2/safes/{address}/multisig-transactions/
      sendJson(res, 201, { success: true });
    } else if (
      req.method === 'GET' &&
      url.includes('/safes/') &&
      url.includes('multisig-transactions')
    ) {
      // Mock GET /v2/safes/${address}/multisig-transactions/`
      sendJson(res, 200, { count: 0, results: [] });
    } else if (url.includes('/safes/')) {
      // Mock GET /api/v1/safes/{address}/
      sendJson(res, 200, {
        address: safeAddress,
        nonce,
        threshold: 1,
        owners: [safeOwner],
        masterCopy: safeAddress,
        modules: [],
        version: '1.3.0',
      });
    } else if (url.includes('/delegates')) {
      // Mock GET /api/v2/delegates?safe={address}
      sendJson(res, 200, { count: 1, results: [{ delegate: safeOwner }] });
    } else {
      res.statusCode = 404;
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  return {
    server,
    url: serviceUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
