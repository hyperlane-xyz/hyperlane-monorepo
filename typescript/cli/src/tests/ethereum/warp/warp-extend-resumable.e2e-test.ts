import { expect } from 'chai';
import { privateKeyToAccount } from 'viem/accounts';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type HypTokenRouterConfig,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ensure0x } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { getDomainId } from '../commands/helpers.js';
import {
  extendWarpConfig,
  hyperlaneWarpApply,
  hyperlaneWarpApplyRaw,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_4_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  TEMP_PATH,
  WARP_CONFIG_PATH_2,
  WARP_CONFIG_PATH_EXAMPLE,
  WARP_CORE_CONFIG_PATH_2,
  WARP_DEPLOY_2_ID,
  WARP_DEPLOY_CONFIG_CHAIN_2,
  getCombinedWarpRoutePath,
} from '../consts.js';

describe('hyperlane warp apply resumable extension tests', async function () {
  this.timeout(3 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain3Addresses: ChainAddresses = {};
  let chain4Addresses: ChainAddresses = {};

  before(async function () {
    [, chain3Addresses, chain4Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_4, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );
    const anvil2Config = { anvil2: { ...warpConfig.anvil1 } };
    writeYamlOrJson(WARP_CONFIG_PATH_2, anvil2Config);
  });

  beforeEach(async function () {
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH_2, WARP_DEPLOY_2_ID);
  });

  it('should not redeploy previously successful chain extensions on re-run', async () => {
    const ownerAddress = privateKeyToAccount(ensure0x(ANVIL_KEY)).address;

    // Step 1: Extend warp route from anvil2 to anvil3 only
    const config3: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain3Addresses!.mailbox,
      name: 'Ether',
      owner: ownerAddress,
      symbol: 'ETH',
      type: TokenType.native,
    };

    await extendWarpConfig({
      chain: CHAIN_NAME_2,
      chainToExtend: CHAIN_NAME_3,
      extendedConfig: config3,
      warpCorePath: WARP_CORE_CONFIG_PATH_2,
      warpDeployPath: WARP_DEPLOY_CONFIG_CHAIN_2,
    });

    // Step 2: Record anvil3's deployed address from the registry
    const combinedWarpCorePath_2_3 = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);
    const warpCoreAfterFirstExtend: WarpCoreConfig = readYamlOrJson(
      combinedWarpCorePath_2_3,
    );
    const anvil3Address = warpCoreAfterFirstExtend.tokens.find(
      (t) => t.chainName === CHAIN_NAME_3,
    )?.addressOrDenom;
    expect(anvil3Address).to.be.a('string');

    // Step 3: Now run warp apply with config for anvil2 + anvil3 + anvil4
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-resumable.yaml`;
    const warpDeployPath3 = `${TEMP_PATH}/warp-route-deployment-resumable-3.yaml`;
    const config2 = await readWarpConfig(
      CHAIN_NAME_2,
      combinedWarpCorePath_2_3,
      warpDeployPath,
    );
    const config3Read = await readWarpConfig(
      CHAIN_NAME_3,
      combinedWarpCorePath_2_3,
      warpDeployPath3,
    );

    // Clean up fields that readWarpConfig adds
    delete config2[CHAIN_NAME_2].remoteRouters;
    delete config2[CHAIN_NAME_2].destinationGas;
    delete config3Read[CHAIN_NAME_3].remoteRouters;
    delete config3Read[CHAIN_NAME_3].destinationGas;

    const warpDeployConfig = {
      ...config2,
      ...config3Read,
      [CHAIN_NAME_4]: {
        decimals: 18,
        mailbox: chain4Addresses!.mailbox,
        name: 'Ether',
        owner: ownerAddress,
        symbol: 'ETH',
        type: TokenType.native,
      },
    };

    writeYamlOrJson(warpDeployPath, warpDeployConfig);

    await hyperlaneWarpApply(warpDeployPath, combinedWarpCorePath_2_3);

    // Step 4: Read the resulting warp core config (now includes all 3 chains)
    const combinedWarpCorePath_2_3_4 = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      CHAIN_NAME_4,
    ]);
    const finalWarpCoreConfig: WarpCoreConfig = readYamlOrJson(
      combinedWarpCorePath_2_3_4,
    );

    // Step 5: Verify anvil3 address is UNCHANGED (not re-deployed)
    const finalAnvil3Address = finalWarpCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_3,
    )?.addressOrDenom;
    expect(finalAnvil3Address).to.equal(anvil3Address);

    // Step 6: Verify anvil4 was newly deployed
    const anvil4Address = finalWarpCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_4,
    )?.addressOrDenom;
    expect(anvil4Address).to.be.a('string');

    // Step 7: Verify all 3 chains are enrolled in each other
    const chain2Id = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
    const chain3Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);
    const chain4Id = await getDomainId(CHAIN_NAME_4, ANVIL_KEY);

    const readPath = `${TEMP_PATH}/warp-route-read-resumable.yaml`;

    const finalConfig2 = await readWarpConfig(
      CHAIN_NAME_2,
      combinedWarpCorePath_2_3_4,
      readPath,
    );
    const finalConfig3 = await readWarpConfig(
      CHAIN_NAME_3,
      combinedWarpCorePath_2_3_4,
      readPath,
    );
    const finalConfig4 = await readWarpConfig(
      CHAIN_NAME_4,
      combinedWarpCorePath_2_3_4,
      readPath,
    );

    // anvil2 should know about anvil3 and anvil4
    const routers2 = Object.keys(finalConfig2[CHAIN_NAME_2].remoteRouters!);
    expect(routers2).to.include(chain3Id);
    expect(routers2).to.include(chain4Id);

    // anvil3 should know about anvil2 and anvil4
    const routers3 = Object.keys(finalConfig3[CHAIN_NAME_3].remoteRouters!);
    expect(routers3).to.include(chain2Id);
    expect(routers3).to.include(chain4Id);

    // anvil4 should know about anvil2 and anvil3
    const routers4 = Object.keys(finalConfig4[CHAIN_NAME_4].remoteRouters!);
    expect(routers4).to.include(chain2Id);
    expect(routers4).to.include(chain3Id);
  });

  it('should persist successful deployments and allow retry after partial failure', async () => {
    const ownerAddress = privateKeyToAccount(ensure0x(ANVIL_KEY)).address;

    // Save original anvil4 metadata, then break its RPC
    const originalMetadata = readYamlOrJson(CHAIN_4_METADATA_PATH) as Record<
      string,
      unknown
    >;
    const brokenMetadata = {
      ...originalMetadata,
      rpcUrls: [{ http: 'http://127.0.0.1:9999' }],
    };
    writeYamlOrJson(CHAIN_4_METADATA_PATH, brokenMetadata);

    // Build deploy config: anvil2 (existing) + anvil3 + anvil4
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-partial.yaml`;
    const config2 = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
    );
    delete config2[CHAIN_NAME_2].remoteRouters;
    delete config2[CHAIN_NAME_2].destinationGas;

    const warpDeployConfig = {
      ...config2,
      [CHAIN_NAME_3]: {
        decimals: 18,
        mailbox: chain3Addresses!.mailbox,
        name: 'Ether',
        owner: ownerAddress,
        symbol: 'ETH',
        type: TokenType.native,
      },
      [CHAIN_NAME_4]: {
        decimals: 18,
        mailbox: chain4Addresses!.mailbox,
        name: 'Ether',
        owner: ownerAddress,
        symbol: 'ETH',
        type: TokenType.native,
      },
    };
    writeYamlOrJson(warpDeployPath, warpDeployConfig);

    // Run warp apply — anvil3 should succeed, anvil4 should fail
    try {
      const result = await hyperlaneWarpApplyRaw({
        warpDeployPath,
        warpCorePath: WARP_CORE_CONFIG_PATH_2,
      }).nothrow();
      expect(result.exitCode).to.not.equal(0);
    } finally {
      writeYamlOrJson(CHAIN_4_METADATA_PATH, originalMetadata);
    }

    // Verify anvil3 was persisted (partial success)
    const combinedWarpCorePath_2_3 = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);
    const partialWarpCore: WarpCoreConfig = readYamlOrJson(
      combinedWarpCorePath_2_3,
    );
    const anvil3Address = partialWarpCore.tokens.find(
      (t) => t.chainName === CHAIN_NAME_3,
    )?.addressOrDenom;
    expect(anvil3Address).to.be.a('string');

    // Re-run warp apply — anvil4 RPC is now restored
    await hyperlaneWarpApply(warpDeployPath, combinedWarpCorePath_2_3);

    // Verify all 3 chains deployed
    const combinedWarpCorePath_2_3_4 = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      CHAIN_NAME_4,
    ]);
    const finalWarpCore: WarpCoreConfig = readYamlOrJson(
      combinedWarpCorePath_2_3_4,
    );

    // anvil3 address unchanged (not re-deployed)
    const finalAnvil3Address = finalWarpCore.tokens.find(
      (t) => t.chainName === CHAIN_NAME_3,
    )?.addressOrDenom;
    expect(finalAnvil3Address).to.equal(anvil3Address);

    // anvil4 newly deployed
    const anvil4Address = finalWarpCore.tokens.find(
      (t) => t.chainName === CHAIN_NAME_4,
    )?.addressOrDenom;
    expect(anvil4Address).to.be.a('string');

    // Verify all 3 chains enrolled in each other
    const chain2Id = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
    const chain3Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);
    const chain4Id = await getDomainId(CHAIN_NAME_4, ANVIL_KEY);

    const readPath = `${TEMP_PATH}/warp-route-read-partial.yaml`;

    const finalConfig2 = await readWarpConfig(
      CHAIN_NAME_2,
      combinedWarpCorePath_2_3_4,
      readPath,
    );
    const finalConfig3 = await readWarpConfig(
      CHAIN_NAME_3,
      combinedWarpCorePath_2_3_4,
      readPath,
    );
    const finalConfig4 = await readWarpConfig(
      CHAIN_NAME_4,
      combinedWarpCorePath_2_3_4,
      readPath,
    );

    const routers2 = Object.keys(finalConfig2[CHAIN_NAME_2].remoteRouters!);
    expect(routers2).to.include(chain3Id);
    expect(routers2).to.include(chain4Id);

    const routers3 = Object.keys(finalConfig3[CHAIN_NAME_3].remoteRouters!);
    expect(routers3).to.include(chain2Id);
    expect(routers3).to.include(chain4Id);

    const routers4 = Object.keys(finalConfig4[CHAIN_NAME_4].remoteRouters!);
    expect(routers4).to.include(chain2Id);
    expect(routers4).to.include(chain3Id);
  });
});
