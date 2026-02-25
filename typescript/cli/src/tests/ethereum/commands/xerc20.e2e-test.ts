import { expect } from 'chai';
import { Wallet } from 'ethers';
import { $ } from 'zx';

import {
  type ERC20Test,
  type XERC20LockboxTest,
  type XERC20VSTest,
} from '@hyperlane-xyz/core';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
  XERC20Type,
} from '@hyperlane-xyz/sdk';
import { type Address, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

import { deployOrUseExistingCore } from './core.js';
import {
  deployToken,
  deployXERC20LockboxToken,
  deployXERC20VSToken,
  localTestRunCmdPrefix,
} from './helpers.js';
import { hyperlaneWarpDeploy } from './warp.js';

$.verbose = true;

describe('xerc20 e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses;
  let chain3Addresses: ChainAddresses;
  let ownerAddress: Address;

  let tokenChain2: ERC20Test;
  let xERC20Lockbox2: XERC20LockboxTest;
  let xERC20VS2: XERC20VSTest;
  let xERC20VS3: XERC20VSTest;

  const XERC20_LOCKBOX_DEPLOY_PATH = `${TEMP_PATH}/warp-xerc20-lockbox-deploy.yaml`;
  const XERC20_LOCKBOX_CORE_PATH = getCombinedWarpRoutePath('XERC20', [
    CHAIN_NAME_2,
  ]);
  const XERC20_VS_DEPLOY_PATH = `${TEMP_PATH}/warp-xerc20-vs-deploy.yaml`;
  const XERC20_VS_CORE_PATH = getCombinedWarpRoutePath('XERC20VS', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(
        CHAIN_NAME_2,
        './examples/core-config.yaml',
        ANVIL_KEY,
      ),
      deployOrUseExistingCore(
        CHAIN_NAME_3,
        './examples/core-config.yaml',
        ANVIL_KEY,
      ),
    ]);

    ownerAddress = new Wallet(ANVIL_KEY).address;

    tokenChain2 = await deployToken(ANVIL_KEY, CHAIN_NAME_2, 18, 'XERC20');
    xERC20Lockbox2 = await deployXERC20LockboxToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      tokenChain2,
    );

    xERC20VS2 = await deployXERC20VSToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      18,
      'XERC20VS',
    );
    xERC20VS3 = await deployXERC20VSToken(
      ANVIL_KEY,
      CHAIN_NAME_3,
      18,
      'XERC20VS',
    );
  });

  const BRIDGE_LIMITS = {
    bufferCap: '1000000000000000000000',
    rateLimitPerSecond: '1000000000000000000',
  };

  async function deployWarpRoutesAndSetupBridges(): Promise<void> {
    const [xERC20Lockbox2Address, xERC20VS2Address, xERC20VS3Address] =
      await Promise.all([
        xERC20Lockbox2.getAddress(),
        xERC20VS2.getAddress(),
        xERC20VS3.getAddress(),
      ]);

    const xerc20LockboxConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.XERC20Lockbox,
        token: xERC20Lockbox2Address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
    };
    writeYamlOrJson(XERC20_LOCKBOX_DEPLOY_PATH, xerc20LockboxConfig);
    await hyperlaneWarpDeploy(XERC20_LOCKBOX_DEPLOY_PATH, 'XERC20/anvil2');

    const xerc20VSConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.XERC20,
        token: xERC20VS2Address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.XERC20,
        token: xERC20VS3Address,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };
    writeYamlOrJson(XERC20_VS_DEPLOY_PATH, xerc20VSConfig);
    await hyperlaneWarpDeploy(XERC20_VS_DEPLOY_PATH, 'XERC20VS/anvil2-anvil3');

    const xerc20VSCoreConfig: WarpCoreConfig =
      readYamlOrJson(XERC20_VS_CORE_PATH);
    const vsWarpRouteAddress2 = xerc20VSCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_2,
    )?.addressOrDenom;
    const vsWarpRouteAddress3 = xerc20VSCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_3,
    )?.addressOrDenom;

    // Use fresh signers to avoid stale NonceManager state after CLI txs.
    const provider2 = xERC20VS2.runner?.provider;
    const provider3 = xERC20VS3.runner?.provider;
    assert(provider2, 'Missing provider for xERC20VS2');
    assert(provider3, 'Missing provider for xERC20VS3');
    const xERC20VS2WithFreshSigner = xERC20VS2.connect(
      new Wallet(ANVIL_KEY, provider2),
    );
    const xERC20VS3WithFreshSigner = xERC20VS3.connect(
      new Wallet(ANVIL_KEY, provider3),
    );

    if (vsWarpRouteAddress2) {
      const tx = await xERC20VS2WithFreshSigner.addBridge({
        bridge: vsWarpRouteAddress2,
        ...BRIDGE_LIMITS,
      });
      await tx.wait();
    }

    if (vsWarpRouteAddress3) {
      const tx = await xERC20VS3WithFreshSigner.addBridge({
        bridge: vsWarpRouteAddress3,
        ...BRIDGE_LIMITS,
      });
      await tx.wait();
    }

    const xerc20VSConfigWithLimits: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.XERC20,
        token: xERC20VS2Address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Velo,
            ...BRIDGE_LIMITS,
          },
        },
      },
      [CHAIN_NAME_3]: {
        type: TokenType.XERC20,
        token: xERC20VS3Address,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Velo,
            ...BRIDGE_LIMITS,
          },
        },
      },
    };
    writeYamlOrJson(XERC20_VS_DEPLOY_PATH, xerc20VSConfigWithLimits);
  }

  beforeEach(async function () {
    await deployWarpRoutesAndSetupBridges();
  });

  describe('apply', function () {
    it('reports no updates when config matches on-chain state', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_VS_DEPLOY_PATH} \
        --warp ${XERC20_VS_CORE_PATH} \
        --chains ${CHAIN_NAME_2} \
        --key ${ANVIL_KEY} \
        --verbosity debug`;

      expect(result.stdout).to.include('No updates needed');
    });

    it('generates transactions when config specifies different limits', async function () {
      const xERC20VS2Address = await xERC20VS2.getAddress();
      const configWithLimits: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.XERC20,
          token: xERC20VS2Address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          xERC20: {
            warpRouteLimits: {
              type: XERC20Type.Velo,
              bufferCap: '2000000000000000000000',
              rateLimitPerSecond: '2000000000000000000',
            },
          },
        },
      };
      const configPath = `${TEMP_PATH}/xerc20-apply-test.yaml`;
      writeYamlOrJson(configPath, configWithLimits);

      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
        --registry ${REGISTRY_PATH} \
        --config ${configPath} \
        --warp ${XERC20_VS_CORE_PATH} \
        --chains ${CHAIN_NAME_2} \
        --key ${ANVIL_KEY} \
        --verbosity debug`;

      expect(result.stdout).to.include('Generated');
    });

    it('applies to all chains when --chains is not specified', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_VS_DEPLOY_PATH} \
        --warp ${XERC20_VS_CORE_PATH} \
        --key ${ANVIL_KEY} \
        --verbosity debug`;

      expect(result.stdout).to.include(CHAIN_NAME_2);
      expect(result.stdout).to.include(CHAIN_NAME_3);
    });
  });

  describe('read', function () {
    it('displays current limits for Velodrome XERC20', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 read \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_VS_DEPLOY_PATH} \
        --warp ${XERC20_VS_CORE_PATH} \
        --chains ${CHAIN_NAME_2} \
        --verbosity debug`;

      const output = result.stdout;
      expect(output).to.include('velo');
    });

    it('displays current limits for Standard XERC20', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 read \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_LOCKBOX_DEPLOY_PATH} \
        --warp ${XERC20_LOCKBOX_CORE_PATH} \
        --verbosity debug`;

      const output = result.stdout;
      expect(output).to.include(CHAIN_NAME_2);
    });

    it('filters by chain when --chains is specified', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 read \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_VS_DEPLOY_PATH} \
        --warp ${XERC20_VS_CORE_PATH} \
        --chains ${CHAIN_NAME_2} \
        --verbosity debug`;

      const output = result.stdout;
      expect(output).to.include(CHAIN_NAME_2);
    });
  });
});
