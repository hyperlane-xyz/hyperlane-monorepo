import fs from 'fs';

import { type ChainMetadata } from '@hyperlane-xyz/sdk';

import {
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';
import { runEvmNode } from '../nodes.js';
import { readYamlOrJson } from '../../utils/files.js';

import {
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_4_METADATA_PATH,
  REGISTRY_PATH as OLD_REGISTRY_PATH,
} from './consts.js';

async function isRpcReady(rpcUrl: string): Promise<boolean> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_chainId',
        params: [],
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureEvmNodeForChain(
  chainId: number | string,
  rpcPort: number,
): Promise<void> {
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  if (await isRpcReady(rpcUrl)) return;
  await runEvmNode({
    rpcPort,
    chainId: Number(chainId),
  } as Parameters<typeof runEvmNode>[0]);
}

async function ensureAllEvmNodesRunning(): Promise<void> {
  const testRegistryChains = [
    TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_4,
  ];
  const legacyRegistryChains = [
    readYamlOrJson(CHAIN_2_METADATA_PATH),
    readYamlOrJson(CHAIN_3_METADATA_PATH),
    readYamlOrJson(CHAIN_4_METADATA_PATH),
  ] as ChainMetadata[];

  await Promise.all(
    testRegistryChains.map(({ chainId, rpcPort }) =>
      ensureEvmNodeForChain(Number(chainId), rpcPort),
    ),
  );
  await Promise.all(
    legacyRegistryChains.map((metadata: ChainMetadata) =>
      ensureEvmNodeForChain(
        Number(metadata.chainId),
        parseInt(new URL(metadata.rpcUrls[0].http).port, 10),
      ),
    ),
  );
}

before(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);
  await ensureAllEvmNodesRunning();

  for (const registryPath of [REGISTRY_PATH, OLD_REGISTRY_PATH]) {
    Object.entries(TEST_CHAIN_NAMES_BY_PROTOCOL).forEach(
      ([_protocol, chainNames]) => {
        Object.entries(chainNames).map(([_key, name]) => {
          const path = `${registryPath}/chains/${name}/addresses.yaml`;

          if (fs.existsSync(path)) {
            fs.rmSync(path, { recursive: true, force: true });
          }
        });
      },
    );
  }
});

// Reset the test registry for each test invocation
beforeEach(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);
  await ensureAllEvmNodesRunning();
  for (const registryPath of [REGISTRY_PATH, OLD_REGISTRY_PATH]) {
    const deploymentPaths = `${registryPath}/deployments/warp_routes`;

    if (fs.existsSync(deploymentPaths)) {
      fs.rmSync(deploymentPaths, { recursive: true, force: true });
    }
  }
});
