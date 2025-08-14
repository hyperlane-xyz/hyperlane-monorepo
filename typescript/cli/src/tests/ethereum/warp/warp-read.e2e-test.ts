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
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_2,
  CORE_READ_CONFIG_PATH_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
  WARP_CONFIG_PATH_2,
  WARP_CONFIG_PATH_EXAMPLE,
  WARP_CORE_CONFIG_PATH_2,
  WARP_DEPLOY_2_ID,
  WARP_DEPLOY_OUTPUT_PATH,
} from '../consts.js';

describe('hyperlane warp read e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore2 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_2,
  );

  const hyperlaneCore3 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    CHAIN_NAME_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_3,
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
      hyperlaneCore2.deployOrUseExistingCore(ANVIL_KEY),
      hyperlaneCore3.deployOrUseExistingCore(ANVIL_KEY),
    ]);

    ownerAddress = new Wallet(ANVIL_KEY).address;
  });

  before(async function () {
    await hyperlaneCore2.deployOrUseExistingCore(ANVIL_KEY);

    // Create a new warp config using the example
    const exampleWarpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );
    anvil2Config = { [CHAIN_NAME_2]: { ...exampleWarpConfig.anvil1 } };
    writeYamlOrJson(WARP_CONFIG_PATH_2, anvil2Config);
  });

  describe('hyperlane warp read --config ...', () => {
    it('should exit early if no symbol or no chain and address', async () => {
      await hyperlaneWarp.deploy(WARP_CONFIG_PATH_2, ANVIL_KEY);

      const output = await hyperlaneWarp.readRaw({}).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.include(
        'Invalid input parameters. Please provide either a token symbol or both chain name and token address',
      );
    });
  });

  describe('hyperlane warp read --config ... --symbol ...', () => {
    it('should successfully read the complete warp route config from all the chains', async () => {
      await hyperlaneWarp.deploy(WARP_CONFIG_PATH_2, ANVIL_KEY);

      const output = await hyperlaneWarp
        .readRaw({
          symbol: 'ETH',
        })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);

      const warpReadResult: WarpRouteDeployConfig =
        readYamlOrJson(WARP_CONFIG_PATH_2);
      expect(warpReadResult[CHAIN_NAME_2]).not.to.be.undefined;
      expect(warpReadResult[CHAIN_NAME_2].type).to.equal(TokenType.native);
    });
  });

  describe('hyperlane warp read --symbol ...', () => {
    it('should successfully read the complete warp route config from all the chains', async () => {
      const readOutputPath = `${TEMP_PATH}/warp-read-all-chain-with-symbol.yaml`;

      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.synthetic,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.native,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarp.deploy(WARP_DEPLOY_OUTPUT_PATH, ANVIL_KEY);

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
      expect(warpReadResult[CHAIN_NAME_2]).not.to.be.undefined;
      expect(warpReadResult[CHAIN_NAME_2].type).to.equal(TokenType.synthetic);

      expect(warpReadResult[CHAIN_NAME_3]).not.to.be.undefined;
      expect(warpReadResult[CHAIN_NAME_3].type).to.equal(TokenType.native);
    });
  });

  describe('hyperlane warp read --chain ... --config ...', () => {
    it('should be able to read a warp route', async function () {
      await hyperlaneWarp.deploy(
        WARP_CONFIG_PATH_2,
        ANVIL_KEY,
        WARP_DEPLOY_2_ID,
      );

      const warpReadResult: WarpRouteDeployConfig =
        await hyperlaneWarp.readConfig(CHAIN_NAME_2, WARP_CORE_CONFIG_PATH_2);

      expect(warpReadResult[CHAIN_NAME_2].type).to.be.equal(
        anvil2Config[CHAIN_NAME_2].type,
      );
    });
  });
});
