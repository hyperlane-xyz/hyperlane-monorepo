import { ethers } from 'ethers';
import http from 'http';
import { $, type ProcessPromise } from 'zx';

import {
  type MockExecutorQuoterRouter,
  MockExecutorQuoterRouter__factory,
  type MockWormholeCore,
  MockWormholeCore__factory,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import {
  type ChainMap,
  type ChainName,
  EvmWormholeHookIsmModule,
  type MultiProvider,
  WormholeConsistencyLevel,
  WormholeConsistencyType,
  type WormholeHookIsmConfig,
  type WormholeMeshConfig,
  WormholeVariant,
} from '@hyperlane-xyz/sdk';
import { type Address, addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { getContext } from '../../../context/context.js';
import { setSignerForChain } from '../commands/helpers.js';
import { ANVIL_KEY, REGISTRY_PATH } from '../consts.js';

/**
 * Local Wormhole fixture for the CLI E2E suite.
 *
 * Anvil has no Guardian network, so Wormhole Core and the Executor Quoter
 * Router are replaced with the repository's deterministic mocks. Everything
 * above them — the CLI, the SDK deploy/read/apply module, the metadata builder,
 * the CCIP-read HTTP handler, and `Mailbox.process` — is the real thing.
 */

export const WH_CHAIN_ID_2 = 4001;
export const WH_CHAIN_ID_3 = 4002;
export const CALLBACK_GAS_LIMIT = 400_000n;
export const CORE_MESSAGE_FEE = 0n;
export const EXECUTOR_FEE = 0n;

export interface WormholeChainFixture {
  chain: ChainName;
  wormholeChainId: number;
  core: MockWormholeCore;
  quoterRouter: MockExecutorQuoterRouter;
}

export async function getMultiProvider(): Promise<MultiProvider> {
  const { multiProvider } = await getContext({
    registryUris: [REGISTRY_PATH],
    key: ANVIL_KEY,
  });
  return multiProvider;
}

/** Deploys the mock Wormhole infrastructure a chain's router will point at. */
export async function deployWormholeMocks(
  multiProvider: MultiProvider,
  chain: ChainName,
  wormholeChainId: number,
): Promise<WormholeChainFixture> {
  setSignerForChain(multiProvider, chain, ANVIL_KEY);

  const core = await multiProvider.handleDeploy(
    chain,
    new MockWormholeCore__factory(),
    [wormholeChainId, CORE_MESSAGE_FEE],
  );
  const quoterRouter = await multiProvider.handleDeploy(
    chain,
    new MockExecutorQuoterRouter__factory(),
    [EXECUTOR_FEE],
  );

  return { chain, wormholeChainId, core, quoterRouter };
}

/**
 * Builds a symmetric two-chain mesh config. Router addresses are placeholders
 * until `deployMesh` fills in the real ones — the routers cannot know each
 * other's address before they exist.
 */
export function buildMeshConfig({
  variant,
  origin,
  destination,
  mailboxes,
  owner,
  urls,
}: {
  variant: WormholeVariant;
  origin: WormholeChainFixture;
  destination: WormholeChainFixture;
  mailboxes: ChainMap<Address>;
  owner: Address;
  urls?: Array<string>;
}): WormholeMeshConfig {
  const chainConfig = (
    self: WormholeChainFixture,
    remote: WormholeChainFixture,
  ): WormholeHookIsmConfig => {
    const remoteRouter = {
      router: ethers.constants.AddressZero,
      wormholeChainId: remote.wormholeChainId,
      expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
      ...(variant === WormholeVariant.Executor
        ? { quoter: owner, callbackGasLimit: CALLBACK_GAS_LIMIT }
        : {}),
    };

    return {
      type: variant,
      owner,
      mailbox: mailboxes[self.chain],
      core: self.core.address,
      consistencyLevel: { type: WormholeConsistencyType.Finalized },
      remoteRouters: { [remote.chain]: remoteRouter },
      ...(variant === WormholeVariant.Executor
        ? { executorQuoterRouter: self.quoterRouter.address }
        : { urls }),
    };
  };

  return {
    [origin.chain]: chainConfig(origin, destination),
    [destination.chain]: chainConfig(destination, origin),
  };
}

/**
 * Deploys one router per chain and enrolls the mesh once every address exists.
 *
 * `deployMesh` replaces the placeholder router addresses, so the enrollment the
 * routers end up with is derived from the deployment, never hand-written.
 */
export async function deployWormholeMesh(
  multiProvider: MultiProvider,
  mesh: WormholeMeshConfig,
): Promise<ChainMap<Address>> {
  for (const chain of Object.keys(mesh)) {
    setSignerForChain(multiProvider, chain, ANVIL_KEY);
  }
  return EvmWormholeHookIsmModule.deployMesh(multiProvider, mesh);
}

/** Points the deployed TestRecipient at the local Wormhole router. */
export async function setRecipientIsm(
  multiProvider: MultiProvider,
  chain: ChainName,
  testRecipient: Address,
  ism: Address,
): Promise<void> {
  setSignerForChain(multiProvider, chain, ANVIL_KEY);
  const recipient = TestRecipient__factory.connect(
    testRecipient,
    multiProvider.getSigner(chain),
  );
  await multiProvider.handleTx(
    chain,
    recipient.setInterchainSecurityModule(ism),
  );
}

export interface WormholePublication {
  sender: Address;
  sequence: string;
  nonce: number;
  payload: string;
  consistencyLevel: number;
}

/**
 * Extracts the publications the mock Core emitted in a dispatch transaction.
 *
 * The E2E asserts there is exactly one, which is the same ambiguity check the
 * lookup service and the destination router both enforce.
 */
export async function readPublications(
  multiProvider: MultiProvider,
  chain: ChainName,
  txHash: string,
  core: MockWormholeCore,
): Promise<Array<WormholePublication>> {
  const receipt = await multiProvider
    .getProvider(chain)
    .getTransactionReceipt(txHash);
  assert(receipt, `No receipt for ${txHash} on ${chain}`);

  const iface = MockWormholeCore__factory.createInterface();
  const publications: Array<WormholePublication> = [];

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== core.address.toLowerCase()) continue;
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed.name !== 'LogMessagePublished') continue;
    publications.push({
      sender: parsed.args.sender,
      sequence: parsed.args.sequence.toString(),
      nonce: parsed.args.nonce,
      payload: parsed.args.payload,
      consistencyLevel: parsed.args.consistencyLevel,
    });
  }

  return publications;
}

/** Builds the mock VAA the destination Core will accept for a publication. */
export function encodeMockVaa({
  emitterChainId,
  emitterAddress,
  publication,
}: {
  emitterChainId: number;
  emitterAddress: Address;
  publication: WormholePublication;
}): string {
  // Real v1 VAA wire layout with zero mock signatures. The CCIP service parses
  // this exact layout; MockWormholeCore deliberately accepts it without doing
  // Guardian cryptography, which is covered by the Core fork tests.
  return ethers.utils.solidityPack(
    [
      'uint8',
      'uint32',
      'uint8',
      'uint32',
      'uint32',
      'uint16',
      'bytes32',
      'uint64',
      'uint8',
      'bytes',
    ],
    [
      1,
      0,
      0,
      1_700_000_000,
      publication.nonce,
      emitterChainId,
      addressToBytes32(emitterAddress),
      publication.sequence,
      publication.consistencyLevel,
      publication.payload,
    ],
  );
}

/**
 * Submits a VAA to the destination router from an account with no relationship
 * to the Executor quote, proving the callback is permissionless.
 */
export async function submitExecutorCallback({
  multiProvider,
  chain,
  router,
  encodedVaa,
  rescuerKey,
}: {
  multiProvider: MultiProvider;
  chain: ChainName;
  router: Address;
  encodedVaa: string;
  rescuerKey: string;
}): Promise<void> {
  const provider = multiProvider.getProvider(chain);
  const rescuer = new ethers.Wallet(rescuerKey, provider);

  const iface = new ethers.utils.Interface([
    'function executeVAAv1(bytes encodedVaa) payable',
  ]);
  const tx = await rescuer.sendTransaction({
    to: router,
    data: iface.encodeFunctionData('executeVAAv1', [encodedVaa]),
  });
  await tx.wait();
}

/**
 * Deterministic stand-in for Wormholescan.
 *
 * Only the upstream VAA endpoint is faked. The `WormholeVaaService` that reads
 * from it runs for real, so the ABI handler, the receipt scan, the tuple
 * recheck, and the response encoding are all exercised.
 */
export interface LocalVaaUpstream {
  url: string;
  close: () => Promise<void>;
  setAvailable: (available: boolean) => void;
  requestCount: () => number;
}

export async function startVaaUpstream(
  vaaForId: (vaaId: string) => string | undefined,
): Promise<LocalVaaUpstream> {
  let available = true;
  let requests = 0;

  const server = http.createServer((req, res) => {
    requests += 1;
    if (!available) {
      res.writeHead(503).end('unavailable');
      return;
    }

    const vaaId = (req.url ?? '').replace('/api/v1/vaas/', '');
    const encodedVaa = vaaForId(vaaId);
    if (!encodedVaa) {
      // Wormholescan answers 404 while Guardians have not signed yet.
      res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const base64 = Buffer.from(ethers.utils.arrayify(encodedVaa)).toString(
      'base64',
    );
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ data: { vaa: base64 } }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(
    address && typeof address === 'object',
    'Failed to bind the VAA upstream',
  );

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    setAvailable: (value: boolean) => {
      available = value;
    },
    requestCount: () => requests,
  };
}

/**
 * Starts the real `WormholeVaaService` by running the ccip-server with only the
 * `wormhole` module enabled.
 *
 * Running the actual server — rather than re-mounting the router in-process —
 * keeps the express wiring, the ABI handler, and the CCIP-read response shape
 * inside this test's blast radius, which is the point of the E2E.
 */
export interface LocalVaaService {
  url: string;
  close: () => Promise<void>;
}

export interface WormholeServiceRoute {
  core: Address;
  wormholeChainId: number;
  router: Address;
}

export async function startWormholeVaaService({
  port,
  upstreamUrl,
  routes,
}: {
  port: number;
  upstreamUrl: string;
  routes: Record<string, WormholeServiceRoute>;
}): Promise<LocalVaaService> {
  const serverProcess: ProcessPromise = $({
    env: {
      ...process.env,
      ENABLED_MODULES: 'wormhole',
      SERVER_PORT: String(port),
      REGISTRY_URI: REGISTRY_PATH,
      WORMHOLE_VAA_URLS: upstreamUrl,
      WORMHOLE_ROUTES: JSON.stringify(routes),
      WORMHOLE_VAA_MAX_ATTEMPTS: '3',
      WORMHOLE_VAA_RETRY_DELAY_MS: '250',
      // The relayer supplies origin_tx_hash, so the Explorer is never reached.
      HYPERLANE_EXPLORER_URL: 'http://127.0.0.1:1',
    },
    nothrow: true,
  })`pnpm --filter @hyperlane-xyz/ccip-server run start`;

  const health = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(health);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    assert(Date.now() < deadline, 'WormholeVaaService did not become healthy');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return {
    url: `http://127.0.0.1:${port}/wormhole/getWormholeVaa`,
    close: async () => {
      await serverProcess.kill();
    },
  };
}
