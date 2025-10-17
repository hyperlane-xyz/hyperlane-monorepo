import { expect } from 'chai';

import {
  HookType,
  TokenType,
  WarpRouteDeployConfig,
  normalizeConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, normalizeAddress } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  DEFAULT_EVM_WARP_CORE_PATH,
  DEFAULT_EVM_WARP_DEPLOY_PATH,
  DEFAULT_EVM_WARP_ID,
  DEPLOYER_ADDRESS_BY_PROTOCOL,
  E2E_BURN_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';

describe('hyperlane warp apply owner update tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const evmChain1Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    DEFAULT_EVM_WARP_CORE_PATH,
  );

  let DEPLOYER_ADDRESS: string;
  let warpDeployConfig: WarpRouteDeployConfig;

  before(async function () {
    DEPLOYER_ADDRESS = await DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum();

    await evmChain1Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum);
  });

  beforeEach(async function () {
    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.native,
        owner: DEPLOYER_ADDRESS,
      },
    };
    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

    await evmWarpCommands.deploy(
      DEFAULT_EVM_WARP_DEPLOY_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );
  });

  describe('ownership updates', () => {
    async function assertOwnershipSetup({
      expectedTokenOwner,
      expectedProxyAdminOwner,
    }: {
      expectedTokenOwner: Address;
      expectedProxyAdminOwner: Address;
    }) {
      const updatedWarpDeployConfig = await evmWarpCommands.readConfig(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        DEFAULT_EVM_WARP_CORE_PATH,
      );

      expect(
        normalizeAddress(
          updatedWarpDeployConfig[
            TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
          ].owner,
        ),
      ).to.eq(expectedTokenOwner);
      expect(
        normalizeAddress(
          updatedWarpDeployConfig[
            TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
          ].proxyAdmin!.owner,
        ),
      ).to.eq(expectedProxyAdminOwner);
    }

    it('should burn owner address', async function () {
      const updatedWarpDeployConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].owner = E2E_BURN_ADDRESS_BY_PROTOCOL.ethereum;
      writeYamlOrJson(updatedWarpDeployConfigPath, warpDeployConfig);

      const output = await evmWarpCommands
        .applyRaw({
          warpDeployPath: updatedWarpDeployConfigPath,
          warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
          hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
        })
        .nothrow();

      expect(output.exitCode).to.eql(0);

      await assertOwnershipSetup({
        expectedProxyAdminOwner: E2E_BURN_ADDRESS_BY_PROTOCOL.ethereum,
        expectedTokenOwner: E2E_BURN_ADDRESS_BY_PROTOCOL.ethereum,
      });
    });

    it('should not update the same owner', async () => {
      const expectedOwner =
        warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .owner;

      const output = await evmWarpCommands
        .applyRaw({
          warpDeployPath: DEFAULT_EVM_WARP_DEPLOY_PATH,
          warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
          hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
        })
        .nothrow();

      expect(output.exitCode).to.eql(0);
      expect(output.text()).to.include(
        'Warp config is the same as target. No updates needed.',
      );

      await assertOwnershipSetup({
        expectedProxyAdminOwner: expectedOwner,
        expectedTokenOwner: expectedOwner,
      });
    });

    it('should update the owner of both the warp token and the proxy admin', async () => {
      const updatedWarpDeployConfigPath = `${TEMP_PATH}/warp-route-deploy-config-2.yaml`;

      const expectedNewOwner = randomAddress();

      // Set to undefined if it was defined in the config
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].proxyAdmin = undefined;
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].owner = expectedNewOwner;
      writeYamlOrJson(updatedWarpDeployConfigPath, warpDeployConfig);

      const output = await evmWarpCommands
        .applyRaw({
          warpDeployPath: updatedWarpDeployConfigPath,
          warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
          hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
        })
        .nothrow();

      expect(output.exitCode).to.eql(0);

      await assertOwnershipSetup({
        expectedProxyAdminOwner: expectedNewOwner,
        expectedTokenOwner: expectedNewOwner,
      });
    });

    it('should update only the owner of the warp token if the proxy admin config is specified', async () => {
      const updatedWarpDeployConfigPath = `${TEMP_PATH}/warp-route-deploy-config-2.yaml`;

      // Explicitly set it to the deployer address if it was not defined
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].proxyAdmin = { owner: DEPLOYER_ADDRESS };
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].owner = E2E_BURN_ADDRESS_BY_PROTOCOL.ethereum;
      writeYamlOrJson(updatedWarpDeployConfigPath, warpDeployConfig);

      const output = await evmWarpCommands
        .applyRaw({
          warpDeployPath: updatedWarpDeployConfigPath,
          warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
          hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
        })
        .nothrow();

      expect(output.exitCode).to.eql(0);

      const updatedWarpDeployConfig = await evmWarpCommands.readConfig(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        DEFAULT_EVM_WARP_CORE_PATH,
      );

      expect(updatedWarpDeployConfig.anvil2.owner).to.eq(
        E2E_BURN_ADDRESS_BY_PROTOCOL.ethereum,
      );
      expect(updatedWarpDeployConfig.anvil2.proxyAdmin?.owner).to.eq(
        DEPLOYER_ADDRESS,
      );
    });

    it('should update only the owner of the proxy admin if the proxy admin config is specified', async () => {
      const updatedWarpDeployConfigPath = `${TEMP_PATH}/warp-route-deploy-config-2.yaml`;

      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].proxyAdmin = { owner: E2E_BURN_ADDRESS_BY_PROTOCOL.ethereum };
      writeYamlOrJson(updatedWarpDeployConfigPath, warpDeployConfig);

      const output = await evmWarpCommands
        .applyRaw({
          warpDeployPath: updatedWarpDeployConfigPath,
          warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
          hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
        })
        .nothrow();

      expect(output.exitCode).to.eql(0);

      await assertOwnershipSetup({
        expectedTokenOwner: DEPLOYER_ADDRESS,
        expectedProxyAdminOwner: E2E_BURN_ADDRESS_BY_PROTOCOL.ethereum,
      });
    });
  });

  it('should update hook configuration', async () => {
    const updatedWarpDeployConfigPath = `${TEMP_PATH}/warp-route-deploy-config-2.yaml`;

    // Update with a new hook config
    const owner = randomAddress();
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].hook =
      {
        type: HookType.PROTOCOL_FEE,
        beneficiary: owner,
        maxProtocolFee: '1000000',
        protocolFee: '100000',
        owner,
      };

    // Write the updated config
    await writeYamlOrJson(updatedWarpDeployConfigPath, warpDeployConfig);

    // Apply the changes
    const output = await evmWarpCommands
      .applyRaw({
        warpDeployPath: updatedWarpDeployConfigPath,
        warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      })
      .nothrow();

    expect(output.exitCode).to.eql(0);

    // Read back the config to verify changes
    const updatedWarpDeployConfig = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      DEFAULT_EVM_WARP_CORE_PATH,
    );

    // Verify the hook was updated with all properties
    expect(
      normalizeConfig(
        updatedWarpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
        ].hook,
      ),
    ).to.deep.equal(
      normalizeConfig(
        warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .hook,
      ),
    );
  });
});
