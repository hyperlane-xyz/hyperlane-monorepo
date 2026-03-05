import fs from 'fs';

import { type ChainMetadata } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';
import { runEvmNode, runTronNode } from '../nodes.js';

import {
  CHAIN_2_METADATA_PATH,
  IS_TRON_TEST,
  REGISTRY_PATH as OLD_REGISTRY_PATH,
} from './consts.js';
import { readYamlOrJson } from '../../utils/files.js';

before(async function () {
  // Use longer timeout for Tron (node startup is slower)
  this.timeout(
    IS_TRON_TEST ? 3 * DEFAULT_E2E_TEST_TIMEOUT : DEFAULT_E2E_TEST_TIMEOUT,
  );

  // When CLI_E2E_EXTERNAL_NODES is set, skip starting local nodes
  // (the caller is responsible for running them externally).
  const useExternalNodes = !!process.env.CLI_E2E_EXTERNAL_NODES;

  if (IS_TRON_TEST && !useExternalNodes) {
    // Read chain metadata to derive port and chainId
    let meta: ChainMetadata;
    let port: number;
    let chainId: number;
    try {
      meta = readYamlOrJson(CHAIN_2_METADATA_PATH);
      assert(
        meta.rpcUrls?.[0]?.http,
        `Missing rpcUrls[0].http in chain metadata`,
      );
      const rpcUrl = meta.rpcUrls[0].http;
      port = Number(new URL(rpcUrl).port);
      assert(port > 0, `Invalid port derived from rpcUrl ${rpcUrl}`);
      chainId = Number(meta.chainId);
      assert(
        Number.isFinite(chainId) && chainId > 0,
        `Invalid chainId ${meta.chainId}`,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to read Tron chain metadata from ${CHAIN_2_METADATA_PATH}: ${msg}`,
      );
    }
    // Single Tron node handles all 3 logical chains (anvil2/3/4 aliases).
    // runTronNode uses a fixed mnemonic so ANVIL_KEY matches account 0.
    await runTronNode({
      name: 'tron-local',
      chainId,
      domainId: meta.domainId ?? chainId,
      port,
    });
  } else if (!useExternalNodes) {
    // Separate Anvil nodes for each chain
    await Promise.all([
      runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2),
      runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3),
      runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_4),
    ]);
  }

  // Clean up existing chain addresses
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
beforeEach(() => {
  for (const registryPath of [REGISTRY_PATH, OLD_REGISTRY_PATH]) {
    const deploymentPaths = `${registryPath}/deployments/warp_routes`;

    if (fs.existsSync(deploymentPaths)) {
      fs.rmSync(deploymentPaths, { recursive: true, force: true });
    }
  }
});
