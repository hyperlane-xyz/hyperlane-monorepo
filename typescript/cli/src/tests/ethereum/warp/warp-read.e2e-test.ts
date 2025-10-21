import { expect } from 'chai';
import { Wallet } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import { TokenType, WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  KeyBoardKeys,
  TestPromptAction,
  handlePrompts,
} from '../../commands/helpers.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  DEFAULT_EVM_WARP_ID,
  EXAMPLES_PATH,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  getWarpCoreConfigPath,
} from '../../constants.js';

describe('hyperlane warp read e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const WARP_CONFIG_PATH_2 = `${TEMP_PATH}/${TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2}/warp-route-deployment-anvil2.yaml`;
  const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/warp-route-deployment.yaml`;

  const hyperlaneCore2 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const hyperlaneCore3 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
  );

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    WARP_CONFIG_PATH_2,
  );

  let anvil2Config: WarpRouteDeployConfig;

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};

  let ownerAddress: Address;

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      hyperlaneCore2.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      hyperlaneCore3.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);

    ownerAddress = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address;
  });

  before(async function () {
    await hyperlaneCore2.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum);

    // Create a new warp config using the example
    const exampleWarpConfigPath = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;
    const exampleWarpConfig: WarpRouteDeployConfig = readYamlOrJson(
      exampleWarpConfigPath,
    );
    anvil2Config = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        ...exampleWarpConfig.anvil1,
      },
    };
    writeYamlOrJson(WARP_CONFIG_PATH_2, anvil2Config);
  });

  describe('hyperlane warp read --config ...', () => {
    it('should exit early if no symbol or no chain and address', async () => {
      await hyperlaneWarp.deploy(
        WARP_CONFIG_PATH_2,
        HYP_KEY_BY_PROTOCOL.ethereum,
      );

      const output = await hyperlaneWarp.readRaw({}).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.include(
        'Invalid input parameters. Please provide either a token symbol, a warp route id or both chain name and token address',
      );
    });
  });

  describe('hyperlane warp read --config ... --symbol ...', () => {
    it('should successfully read the complete warp route config from all the chains', async () => {
      await hyperlaneWarp.deploy(
        WARP_CONFIG_PATH_2,
        HYP_KEY_BY_PROTOCOL.ethereum,
      );

      const output = await hyperlaneWarp
        .readRaw({
          symbol: 'ETH',
        })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);

      const warpReadResult: WarpRouteDeployConfig =
        readYamlOrJson(WARP_CONFIG_PATH_2);
      expect(warpReadResult[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2])
        .not.to.be.undefined;
      expect(
        warpReadResult[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].type,
      ).to.equal(TokenType.native);
    });
  });

  describe('hyperlane warp read --symbol ...', () => {
    it('should successfully read the complete warp route config from all the chains', async () => {
      const readOutputPath = `${TEMP_PATH}/warp-read-all-chain-with-symbol.yaml`;

      const warpConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.synthetic,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          type: TokenType.native,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarp.deploy(
        WARP_DEPLOY_OUTPUT_PATH,
        HYP_KEY_BY_PROTOCOL.ethereum,
      );

      const steps: TestPromptAction[] = [
        // Select the anvil2-anvil3 ETH route from the selection prompt
        {
          check: (currentOutput: string) =>
            currentOutput.includes('Select from matching warp routes'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      const output = hyperlaneWarp
        .readRaw({
          symbol: 'ETH',
          outputPath: readOutputPath,
        })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const warpReadResult: WarpRouteDeployConfig =
        readYamlOrJson(readOutputPath);
      expect(warpReadResult[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2])
        .not.to.be.undefined;
      expect(
        warpReadResult[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].type,
      ).to.equal(TokenType.synthetic);

      expect(warpReadResult[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3])
        .not.to.be.undefined;
      expect(
        warpReadResult[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].type,
      ).to.equal(TokenType.native);
    });
  });

  describe('hyperlane warp read --warpRouteId ...', () => {
    it('should throw an error if no warp route with the provided id exists', async () => {
      const readOutputPath = `${TEMP_PATH}/warp-read-all-chain-with-symbol.yaml`;

      await hyperlaneWarp.deploy(
        WARP_DEPLOY_OUTPUT_PATH,
        HYP_KEY_BY_PROTOCOL.ethereum,
      );

      const warpRouteId = 'ETH/does-not-exist';
      const finalOutput = await hyperlaneWarp
        .readRaw({
          warpRouteId,
          outputPath: readOutputPath,
        })
        .nothrow();

      expect(finalOutput.exitCode).to.equal(1);
      expect(finalOutput.text()).includes(
        `No warp route found with the provided id "${warpRouteId}"`,
      );
    });

    it('should successfully read the complete warp route config from all the chains', async () => {
      const readOutputPath = `${TEMP_PATH}/warp-read-all-chain-with-symbol.yaml`;

      const warpConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.synthetic,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          type: TokenType.native,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarp.deploy(
        WARP_DEPLOY_OUTPUT_PATH,
        HYP_KEY_BY_PROTOCOL.ethereum,
      );

      const finalOutput = await hyperlaneWarp
        .readRaw({
          warpRouteId: 'ETH/warp-route-deployment',
          outputPath: readOutputPath,
        })
        .nothrow();

      expect(finalOutput.exitCode).to.equal(0);

      const warpReadResult: WarpRouteDeployConfig =
        readYamlOrJson(readOutputPath);
      expect(warpReadResult[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2])
        .not.to.be.undefined;
      expect(
        warpReadResult[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].type,
      ).to.equal(TokenType.synthetic);

      expect(warpReadResult[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3])
        .not.to.be.undefined;
      expect(
        warpReadResult[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].type,
      ).to.equal(TokenType.native);
    });
  });

  describe('hyperlane warp read --chain ... --config ...', () => {
    it('should be able to read a warp route', async function () {
      const WARP_CORE_CONFIG_PATH_2 = getWarpCoreConfigPath('ETH', [
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      ]);

      await hyperlaneWarp.deploy(
        WARP_CONFIG_PATH_2,
        HYP_KEY_BY_PROTOCOL.ethereum,
        DEFAULT_EVM_WARP_ID,
      );

      const warpReadResult: WarpRouteDeployConfig =
        await hyperlaneWarp.readConfig(
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          WARP_CORE_CONFIG_PATH_2,
        );

      expect(
        warpReadResult[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].type,
      ).to.be.equal(
        anvil2Config[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].type,
      );
    });
  });
});
