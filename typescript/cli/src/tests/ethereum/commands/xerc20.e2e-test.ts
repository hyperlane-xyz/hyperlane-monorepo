import { readFileSync, writeFileSync } from 'fs';

import { expect } from 'chai';
import { Wallet, utils } from 'ethers';
import { $ } from 'zx';

import {
  type ERC20Test,
  type XERC20LockboxTest,
  type XERC20VSTest,
} from '@hyperlane-xyz/core';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
  XERC20Type,
  isXERC20TokenConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
  getCombinedWarpDeployPath,
  getCombinedWarpRoutePath,
  getWarpRouteId,
} from '../consts.js';

import { deployOrUseExistingCore } from './core.js';
import {
  deployToken,
  deployXERC20LockboxToken,
  deployXERC20VSToken,
  localTestRunCmdPrefix,
} from './helpers.js';
import { hyperlaneWarpDeploy, readWarpConfig } from './warp.js';

$.verbose = true;

describe('xerc20 e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses;
  let chain3Addresses: ChainAddresses;
  let originalChain3MetadataYaml: string | undefined;
  let ownerAddress: Address;

  let tokenChain2: ERC20Test;
  let xERC20Lockbox2: XERC20LockboxTest;
  let xERC20VS2: XERC20VSTest;
  let xERC20VS3: XERC20VSTest;
  let vsWarpRouteAddress2: Address | undefined;
  let vsWarpRouteAddress3: Address | undefined;

  const XERC20_LOCKBOX_DEPLOY_PATH = `${TEMP_PATH}/warp-xerc20-lockbox-deploy.yaml`;
  const XERC20_VS_DEPLOY_PATH = `${TEMP_PATH}/warp-xerc20-vs-deploy.yaml`;
  const XERC20_VS_CORE_PATH = getCombinedWarpRoutePath('XERC20VS', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);

  const XERC20_LOCKBOX_WARP_ROUTE_ID = getWarpRouteId('XERC20', [CHAIN_NAME_2]);
  const XERC20_VS_WARP_ROUTE_ID = getWarpRouteId('XERC20VS', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);
  const XERC20_VS_REGISTRY_DEPLOY_PATH = getCombinedWarpDeployPath('XERC20VS', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);

  before(async function () {
    originalChain3MetadataYaml = readFileSync(CHAIN_3_METADATA_PATH, 'utf8');
    const originalChain3Metadata: ChainMetadata = readYamlOrJson(
      CHAIN_3_METADATA_PATH,
    );
    writeYamlOrJson(CHAIN_3_METADATA_PATH, {
      ...originalChain3Metadata,
      blockExplorers: [],
    });

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

  after(function () {
    if (originalChain3MetadataYaml) {
      writeFileSync(CHAIN_3_METADATA_PATH, originalChain3MetadataYaml);
    }
  });

  const BRIDGE_LIMITS = {
    bufferCap: '1000000000000000000000',
    rateLimitPerSecond: '1000000000000000000',
  };

  // xERC20VS tokens are shared across tests (deployed once in `before`), and the
  // owner-gated addBridge in every `beforeEach` reverts if ownership is stranded
  // on a throwaway wallet. Fund the current owner for gas and hand ownership back
  // to the deployer so subsequent tests keep working.
  async function restoreTokenOwnership(
    token: XERC20VSTest,
    currentOwnerWallet: Wallet,
  ): Promise<void> {
    // If the apply/assertion failed before the handoff landed, the deployer is
    // still the owner and there is nothing to restore.
    const currentOwner = await token.owner();
    if (currentOwner === ownerAddress) return;

    await token.signer
      .sendTransaction({
        to: currentOwnerWallet.address,
        value: utils.parseEther('1'),
      })
      .then((tx) => tx.wait());
    await token
      .connect(currentOwnerWallet)
      .transferOwnership(ownerAddress)
      .then((tx) => tx.wait());
  }

  async function deployWarpRoutesAndSetupBridges(): Promise<void> {
    vsWarpRouteAddress2 = undefined;
    vsWarpRouteAddress3 = undefined;

    const xerc20LockboxConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.XERC20Lockbox,
        token: xERC20Lockbox2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
    };
    writeYamlOrJson(XERC20_LOCKBOX_DEPLOY_PATH, xerc20LockboxConfig);
    await hyperlaneWarpDeploy(XERC20_LOCKBOX_DEPLOY_PATH, 'XERC20/anvil2');

    const xerc20VSConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.XERC20,
        token: xERC20VS2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.XERC20,
        token: xERC20VS3.address,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };
    writeYamlOrJson(XERC20_VS_DEPLOY_PATH, xerc20VSConfig);
    await hyperlaneWarpDeploy(XERC20_VS_DEPLOY_PATH, 'XERC20VS/anvil2-anvil3');

    const xerc20VSCoreConfig: WarpCoreConfig =
      readYamlOrJson(XERC20_VS_CORE_PATH);
    vsWarpRouteAddress2 = xerc20VSCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_2,
    )?.addressOrDenom;
    vsWarpRouteAddress3 = xerc20VSCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_3,
    )?.addressOrDenom;

    assert(vsWarpRouteAddress2, `Missing warp route on ${CHAIN_NAME_2}`);
    assert(vsWarpRouteAddress3, `Missing warp route on ${CHAIN_NAME_3}`);

    await xERC20VS2
      .addBridge({ bridge: vsWarpRouteAddress2, ...BRIDGE_LIMITS })
      .then((tx) => tx.wait());
    await xERC20VS3
      .addBridge({ bridge: vsWarpRouteAddress3, ...BRIDGE_LIMITS })
      .then((tx) => tx.wait());

    const xerc20VSConfigWithLimits: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.XERC20,
        token: xERC20VS2.address,
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
        token: xERC20VS3.address,
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
    // Also write to registry deploy path so --warp-route-id can resolve it
    writeYamlOrJson(XERC20_VS_REGISTRY_DEPLOY_PATH, xerc20VSConfigWithLimits);
  }

  beforeEach(async function () {
    await deployWarpRoutesAndSetupBridges();
  });

  afterEach(async function () {
    await Promise.all([
      vsWarpRouteAddress2
        ? xERC20VS2.removeBridge(vsWarpRouteAddress2).then((tx) => tx.wait())
        : Promise.resolve(),
      vsWarpRouteAddress3
        ? xERC20VS3.removeBridge(vsWarpRouteAddress3).then((tx) => tx.wait())
        : Promise.resolve(),
    ]);
  });

  describe('apply', function () {
    it('reports no updates when config matches on-chain state', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --chains ${CHAIN_NAME_2} \
        --key ${ANVIL_KEY} \
        --verbosity debug`;

      expect(result.stdout).to.include('No updates needed');
    });

    it('generates transactions when config specifies different limits', async function () {
      const configWithLimits: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.XERC20,
          token: xERC20VS2.address,
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
        [CHAIN_NAME_3]: {
          type: TokenType.XERC20,
          token: xERC20VS3.address,
          mailbox: chain3Addresses.mailbox,
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
      writeYamlOrJson(XERC20_VS_REGISTRY_DEPLOY_PATH, configWithLimits);

      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --chains ${CHAIN_NAME_2} \
        --key ${ANVIL_KEY} \
        --verbosity debug`;

      expect(result.stdout).to.include('Generated');
    });

    it('applies to all chains when --chains is not specified', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --key ${ANVIL_KEY} \
        --verbosity debug`;

      expect(result.stdout).to.include(CHAIN_NAME_2);
      expect(result.stdout).to.include(CHAIN_NAME_3);
    });
  });

  describe('ownership transfer', function () {
    it('transfers XERC20 token ownership when config owner differs', async function () {
      const newOwnerWallet = Wallet.createRandom().connect(xERC20VS2.provider);
      const newOwner = newOwnerWallet.address;

      const configWithNewOwner: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.XERC20,
          token: xERC20VS2.address,
          mailbox: chain2Addresses.mailbox,
          owner: newOwner,
          xERC20: {
            warpRouteLimits: {
              type: XERC20Type.Velo,
              ...BRIDGE_LIMITS,
            },
          },
        },
      };
      writeYamlOrJson(XERC20_VS_REGISTRY_DEPLOY_PATH, configWithNewOwner);

      const ownerBefore = await xERC20VS2.owner();
      expect(ownerBefore).to.equal(ownerAddress);

      try {
        await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
          --registry ${REGISTRY_PATH} \
          --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
          --chains ${CHAIN_NAME_2} \
          --key ${ANVIL_KEY} \
          --verbosity debug`;

        const ownerAfter = await xERC20VS2.owner();
        expect(ownerAfter).to.equal(newOwner);
      } finally {
        // Runs even if the apply or assertion throws, so a failure here doesn't
        // strand ownership and cascade into every subsequent test's beforeEach.
        await restoreTokenOwnership(xERC20VS2, newOwnerWallet);
      }
    });

    it('reports no updates when token owner already matches config', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --chains ${CHAIN_NAME_2} \
        --key ${ANVIL_KEY} \
        --verbosity debug`;

      expect(result.stdout).to.include('No updates needed');
    });
  });

  describe('read', function () {
    it('displays the XERC20 token owner', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 read \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --chains ${CHAIN_NAME_2} \
        --verbosity debug`;

      expect(result.stdout).to.include(ownerAddress);
    });

    it('displays current limits for Velodrome XERC20', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 read \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --chains ${CHAIN_NAME_2} \
        --verbosity debug`;

      const output = result.stdout;
      expect(output).to.include('velo');
    });

    it('displays current limits for Standard XERC20', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 read \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_LOCKBOX_WARP_ROUTE_ID} \
        --verbosity debug`;

      const output = result.stdout;
      expect(output).to.include(CHAIN_NAME_2);
    });

    it('filters by chain when --chains is specified', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 read \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --chains ${CHAIN_NAME_2} \
        --verbosity debug`;

      const output = result.stdout;
      expect(output).to.include(CHAIN_NAME_2);
    });
  });

  describe('warp read', function () {
    // A bridge that is neither a lockbox nor the route's own router used to be
    // dropped from the derived config, which reported a token carrying extra
    // bridges as carrying none.
    it('reports an extra bridge that is not a lockbox', async function () {
      const extraBridge = tokenChain2.address;
      await xERC20VS2
        .addBridge({ bridge: extraBridge, ...BRIDGE_LIMITS })
        .then((tx) => tx.wait());

      try {
        const config = await readWarpConfig(
          CHAIN_NAME_2,
          XERC20_VS_CORE_PATH,
          `${TEMP_PATH}/xerc20-vs-extra-bridge-read.yaml`,
        );

        const chainConfig = config[CHAIN_NAME_2];
        assert(
          isXERC20TokenConfig(chainConfig),
          `Expected an xERC20 config for ${CHAIN_NAME_2}`,
        );
        expect(chainConfig.xERC20?.extraBridges).to.deep.equal([
          {
            lockbox: extraBridge,
            limits: { type: XERC20Type.Velo, ...BRIDGE_LIMITS },
          },
        ]);
      } finally {
        // The token is deployed once for the whole suite, so a bridge left
        // behind would make the later apply runs emit a removeBridge.
        await xERC20VS2.removeBridge(extraBridge).then((tx) => tx.wait());
      }
    });
  });
});
