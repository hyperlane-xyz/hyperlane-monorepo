import { expect } from 'chai';
import { Wallet } from 'ethers';

import {
  ChainName,
  TokenType,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../../utils/files.js';
import {
  CONFIRM_DETECTED_OWNER_STEP,
  KeyBoardKeys,
  SELECT_MAINNET_CHAIN_TYPE_STEP,
  TestPromptAction,
  handlePrompts,
} from '../../commands/helpers.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';
import {
  CONFIRM_CHAIN_SELECTION_STEP,
  CONFIRM_DETECTED_PROXY_ADMIN_STEP,
  CONFIRM_DETECTED_TRUSTED_ISM_STEP,
  SELECT_ANVIL_2_AND_ANVIL_3_STEPS,
  SELECT_MAINNET_CHAINS_ANVIL_2_STEP,
  deployToken,
} from '../commands/helpers.js';

describe('hyperlane warp init e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let initialOwnerAddress: Address;
  const WARP_CONFIG_PATH_2 = `${TEMP_PATH}/${TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2}/warp-route-deployment-anvil2.yaml`;

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  );

  before(async function () {
    const wallet = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum);
    initialOwnerAddress = wallet.address;
  });

  describe('hyperlane warp init --yes', () => {
    function assertWarpConfig(
      warpConfig: WarpRouteDeployConfig,
      chainName: ChainName,
    ) {
      expect(warpConfig[chainName]).not.to.be.undefined;

      const chain2TokenConfig = warpConfig[chainName];
      expect(chain2TokenConfig.owner).equal(initialOwnerAddress);
      expect(chain2TokenConfig.type).equal(TokenType.native);
      expect(chain2TokenConfig.interchainSecurityModule).undefined;
      expect(chain2TokenConfig.proxyAdmin).undefined;
    }

    it('should generate a warp deploy config with a single chain', async function () {
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        SELECT_MAINNET_CHAINS_ANVIL_2_STEP,
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Select .+?'s token type/),
          // Scroll up through the token type list and select native
          input: `${KeyBoardKeys.ARROW_UP.repeat(4)}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = evmWarpCommands
        .init(WARP_CONFIG_PATH_2, HYP_KEY_BY_PROTOCOL.ethereum)
        .stdio('pipe');

      await handlePrompts(output, steps);

      const warpConfig: WarpRouteDeployConfig =
        readYamlOrJson(WARP_CONFIG_PATH_2);

      assertWarpConfig(
        warpConfig,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      );
    });

    it('should generate a warp deploy config with a 2 chains warp route (native->native)', async function () {
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        ...SELECT_ANVIL_2_AND_ANVIL_3_STEPS,
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Select .+?'s token type/),
          input: `${KeyBoardKeys.ARROW_UP.repeat(4)}${KeyBoardKeys.ENTER}`,
        },
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Select .+?'s token type/),
          input: `${KeyBoardKeys.ARROW_UP.repeat(4)}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = evmWarpCommands
        .init(WARP_CONFIG_PATH_2, HYP_KEY_BY_PROTOCOL.ethereum)
        .stdio('pipe');

      await handlePrompts(output, steps);

      const warpConfig: WarpRouteDeployConfig =
        readYamlOrJson(WARP_CONFIG_PATH_2);

      [
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      ].map((chainName) => assertWarpConfig(warpConfig, chainName));
    });

    it('should generate a warp deploy config with a 2 chains warp route (collateral->synthetic)', async function () {
      const erc20Token = await deployToken(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        6,
      );
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        ...SELECT_ANVIL_2_AND_ANVIL_3_STEPS,
        // First chain token config
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Select .+?'s token type/),
          // Scroll down through the token type list and select collateral
          input: `${KeyBoardKeys.ARROW_DOWN.repeat(3)}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput: string) =>
            currentOutput.includes('Enter the existing token address on chain'),
          input: `${erc20Token.address}${KeyBoardKeys.ENTER}`,
        },
        // Other chain token config
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Select .+?'s token type/),
          // Select the synthetic token type
          input: `${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = evmWarpCommands
        .init(WARP_CONFIG_PATH_2, HYP_KEY_BY_PROTOCOL.ethereum)
        .stdio('pipe');

      await handlePrompts(output, steps);

      const warpConfig: WarpRouteDeployConfig =
        readYamlOrJson(WARP_CONFIG_PATH_2);

      expect(warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]).not
        .to.be.undefined;

      const chain2TokenConfig =
        warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2];
      expect(chain2TokenConfig.owner).equal(initialOwnerAddress);
      expect(chain2TokenConfig.type).equal(TokenType.collateral);
      expect((chain2TokenConfig as any).token).equal(erc20Token.address);

      expect(warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]).not
        .to.be.undefined;

      const chain3TokenConfig =
        warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3];
      expect(chain3TokenConfig.owner).equal(initialOwnerAddress);
      expect(chain3TokenConfig.type).equal(TokenType.synthetic);
    });

    it('should generate a warp route ID when skipConfirmation is false', async function () {
      const warpRouteId = 'HYPER/abacus-works';
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        SELECT_MAINNET_CHAINS_ANVIL_2_STEP,
        CONFIRM_CHAIN_SELECTION_STEP,
        CONFIRM_DETECTED_OWNER_STEP,
        CONFIRM_DETECTED_PROXY_ADMIN_STEP,
        CONFIRM_DETECTED_TRUSTED_ISM_STEP,
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Select .+?'s token type/),
          input: `${KeyBoardKeys.ARROW_UP.repeat(4)}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Using warp route ID as/),
          input: `${KeyBoardKeys.DECLINE}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Enter the desired warp route ID:/),
          input: `${warpRouteId}${KeyBoardKeys.ENTER}`,
        },
      ];

      // Run without skipConfirmation to ensure warp route ID is generated
      const output = evmWarpCommands
        .initRaw({
          privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
          skipConfirmationPrompts: false,
        })
        .stdio('pipe');

      await handlePrompts(output, steps);

      const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
        `${REGISTRY_PATH}/deployments/warp_routes/${warpRouteId}-deploy.yaml`,
      );
      assertWarpConfig(
        warpConfig,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      );
    });
  });
});
