import { expect } from 'chai';
import { Wallet, providers } from 'ethers';

import {
  NetFlowRateLimitedHookIsm__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  HookType,
  IsmType,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { assert, eqAddress } from '@hyperlane-xyz/utils';

import { syncWarpDeployConfigToRegistry } from '../../commands/warp-config-sync.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpCheck,
  hyperlaneWarpDeploy,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  IS_TRON_TEST,
  REGISTRY_PATH,
  TEMP_PATH,
  TRON_KEY_1,
} from '../consts.js';

const SYMBOL = 'NFR';
const WARP_ID = createWarpRouteConfigId(SYMBOL, CHAIN_NAME_3);
const WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/${WARP_ID}-config.yaml`;
const WARP_DEPLOY_PATH = `${TEMP_PATH}/warp-route-net-flow-config.yaml`;
const EXTENSION_SYMBOL = 'NFREXT';
const EXTENSION_WARP_ID = createWarpRouteConfigId(
  EXTENSION_SYMBOL,
  CHAIN_NAME_2,
);
const EXTENSION_WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/${EXTENSION_WARP_ID}-config.yaml`;
const EXTENSION_WARP_DEPLOY_PATH = `${TEMP_PATH}/warp-route-net-flow-extension-config.yaml`;

const METADATA_BY_CHAIN: Record<string, ChainMetadata> = {
  [CHAIN_NAME_2]: readYamlOrJson(CHAIN_2_METADATA_PATH),
  [CHAIN_NAME_3]: readYamlOrJson(CHAIN_3_METADATA_PATH),
};

describe('hyperlane warp deploy with NetFlowRateLimitedHookIsm e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const deployerAddress = new Wallet(ANVIL_KEY).address;
  const finalOwner = Wallet.createRandom().address;
  const addressesByChain: Record<string, ChainAddresses> = {};

  before(async () => {
    const chain3Key = IS_TRON_TEST ? TRON_KEY_1 : ANVIL_KEY;
    const [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, chain3Key),
    ]);
    addressesByChain[CHAIN_NAME_2] = chain2Addresses;
    addressesByChain[CHAIN_NAME_3] = chain3Addresses;
  });

  function netFlowIsmConfig(): WarpRouteDeployConfig[string]['interchainSecurityModule'] {
    return {
      type: IsmType.AGGREGATION,
      threshold: 2,
      modules: [
        {
          type: IsmType.TRUSTED_RELAYER,
          relayer: deployerAddress,
        },
        {
          type: IsmType.NET_FLOW_RATE_LIMITED,
          thresholdBps: 500,
          duration: 86400n,
          owner: finalOwner,
        },
      ],
    };
  }

  function netFlowHookConfig(): WarpRouteDeployConfig[string]['hook'] {
    return {
      type: HookType.NET_FLOW_RATE_LIMITED,
      thresholdBps: 500,
      duration: 86400n,
      owner: finalOwner,
    };
  }

  it('keeps the deployer as intermediate owner and transfers router and hybrid ownership in the final pass', async () => {
    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        symbol: SYMBOL,
        owner: finalOwner,
        interchainSecurityModule: netFlowIsmConfig(),
        hook: netFlowHookConfig(),
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        symbol: SYMBOL,
        owner: finalOwner,
        interchainSecurityModule: netFlowIsmConfig(),
        hook: netFlowHookConfig(),
      },
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, warpConfig);

    await hyperlaneWarpDeploy(WARP_DEPLOY_PATH, WARP_ID);

    const checkOutput = await hyperlaneWarpCheck(WARP_ID).nothrow();
    expect(checkOutput.exitCode).to.equal(0);
    expect(checkOutput.text()).to.include('No violations found');

    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH,
    );
    const tokenByChain = Object.fromEntries(
      warpCoreConfig.tokens.map((token) => {
        assert(
          token.addressOrDenom,
          `Missing address for ${token.chainName} token`,
        );
        return [token.chainName, token.addressOrDenom];
      }),
    );

    for (const chain of [CHAIN_NAME_2, CHAIN_NAME_3]) {
      const metadata = METADATA_BY_CHAIN[chain];
      assert(metadata, `Missing metadata for ${chain}`);
      const rpcUrl = metadata.rpcUrls[0]?.http;
      assert(rpcUrl, `Missing RPC URL for ${chain}`);
      const routerAddress = tokenByChain[chain];
      assert(routerAddress, `Missing token router for ${chain}`);

      const provider = new providers.JsonRpcProvider(rpcUrl);
      const router = TokenRouter__factory.connect(routerAddress, provider);
      const hybrid = NetFlowRateLimitedHookIsm__factory.connect(
        await router.hook(),
        provider,
      );

      expect(eqAddress(await router.owner(), finalOwner)).to.be.true;
      expect(eqAddress(await hybrid.owner(), finalOwner)).to.be.true;
      expect(eqAddress(await hybrid.warpRouter(), routerAddress)).to.be.true;
    }
  });

  it('extends a plain route with a non-deployer-owned NetFlow hybrid', async () => {
    const plainConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        symbol: EXTENSION_SYMBOL,
        owner: deployerAddress,
      },
    };
    writeYamlOrJson(EXTENSION_WARP_DEPLOY_PATH, plainConfig);
    await hyperlaneWarpDeploy(EXTENSION_WARP_DEPLOY_PATH, EXTENSION_WARP_ID);

    const chain3Addresses = addressesByChain[CHAIN_NAME_3];
    assert(chain3Addresses, `Missing addresses for ${CHAIN_NAME_3}`);
    const sourceNativeToken = METADATA_BY_CHAIN[CHAIN_NAME_2].nativeToken;
    assert(
      sourceNativeToken,
      `Missing native token metadata for ${CHAIN_NAME_2}`,
    );
    const extendedConfig: WarpRouteDeployConfig = {
      ...plainConfig,
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        name: sourceNativeToken.name,
        symbol: EXTENSION_SYMBOL,
        decimals: sourceNativeToken.decimals,
        mailbox: chain3Addresses.mailbox,
        owner: finalOwner,
        interchainSecurityModule: netFlowIsmConfig(),
        hook: netFlowHookConfig(),
      },
    };
    writeYamlOrJson(EXTENSION_WARP_DEPLOY_PATH, extendedConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: EXTENSION_WARP_DEPLOY_PATH,
      warpRouteId: EXTENSION_WARP_ID,
      registryPath: REGISTRY_PATH,
    });

    await hyperlaneWarpApply(EXTENSION_WARP_ID);

    const checkOutput = await hyperlaneWarpCheck(EXTENSION_WARP_ID).nothrow();
    expect(checkOutput.exitCode).to.equal(0);
    expect(checkOutput.text()).to.include('No violations found');

    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      EXTENSION_WARP_CORE_CONFIG_PATH,
    );
    const chain3Token = warpCoreConfig.tokens.find(
      (token) => token.chainName === CHAIN_NAME_3,
    );
    assert(chain3Token?.addressOrDenom, `Missing token for ${CHAIN_NAME_3}`);

    const metadata = METADATA_BY_CHAIN[CHAIN_NAME_3];
    assert(metadata, `Missing metadata for ${CHAIN_NAME_3}`);
    const rpcUrl = metadata.rpcUrls[0]?.http;
    assert(rpcUrl, `Missing RPC URL for ${CHAIN_NAME_3}`);
    const provider = new providers.JsonRpcProvider(rpcUrl);
    const router = TokenRouter__factory.connect(
      chain3Token.addressOrDenom,
      provider,
    );
    const hybrid = NetFlowRateLimitedHookIsm__factory.connect(
      await router.hook(),
      provider,
    );

    expect(eqAddress(await router.owner(), finalOwner)).to.be.true;
    expect(eqAddress(await hybrid.owner(), finalOwner)).to.be.true;
    expect(eqAddress(await hybrid.warpRouter(), router.address)).to.be.true;
  });
});
