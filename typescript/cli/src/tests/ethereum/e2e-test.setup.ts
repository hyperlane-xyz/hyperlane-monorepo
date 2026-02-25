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
import { readYamlOrJson } from '../../utils/files.js';

import { IS_TRON_TEST, REGISTRY_PATH as OLD_REGISTRY_PATH } from './consts.js';

before(async function () {
  // Use longer timeout for Tron (node startup is slower)
  this.timeout(
    IS_TRON_TEST ? 3 * DEFAULT_E2E_TEST_TIMEOUT : DEFAULT_E2E_TEST_TIMEOUT,
  );

  if (process.env.CLI_E2E_EXTERNAL_NODES !== '1') {
    if (IS_TRON_TEST) {
      const tronChainName = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
      const tronMetadataPath = `${OLD_REGISTRY_PATH}/chains/${tronChainName}/metadata.yaml`;
      const tronMetadata: ChainMetadata = readYamlOrJson(tronMetadataPath);
      const tronRpcUrl = tronMetadata.rpcUrls[0]?.http;
      assert(tronRpcUrl, `Missing Tron RPC URL in ${tronMetadataPath}`);

      await runTronNode({
        name: tronMetadata.name,
        chainId: tronMetadata.chainId,
        domainId: tronMetadata.domainId,
        port: parseInt(new URL(tronRpcUrl).port),
      });
    } else {
      await Promise.all([
        runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2),
        runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3),
        runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_4),
      ]);
    }
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
