import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { expect } from 'chai';

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
  CHAIN_NAME_1,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_1,
  CORE_READ_CONFIG_PATH_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY,
  REGISTRY_PATH,
  TEMP_PATH,
  WARP_CONFIG_PATH_1,
  WARP_CONFIG_PATH_EXAMPLE,
  WARP_CORE_CONFIG_PATH_1,
  WARP_DEPLOY_1_ID,
  WARP_DEPLOY_OUTPUT_PATH,
} from '../consts.js';

describe('hyperlane warp read e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore1 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_1,
  );

  const hyperlaneCore2 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_2,
  );

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.CosmosNative,
    REGISTRY_PATH,
    WARP_CONFIG_PATH_1,
  );

  let hyp1Config: WarpRouteDeployConfig;

  let chain1Addresses: ChainAddresses = {};
  let chain2Addresses: ChainAddresses = {};

  let ownerAddress: Address;

  before(async function () {
    [chain1Addresses, chain2Addresses] = await Promise.all([
      hyperlaneCore1.deployOrUseExistingCore(HYP_KEY),
      hyperlaneCore2.deployOrUseExistingCore(HYP_KEY),
    ]);

    const wallet = await DirectSecp256k1Wallet.fromKey(
      Buffer.from(HYP_KEY, 'hex'),
    );
    const accounts = await wallet.getAccounts();
    ownerAddress = accounts[0].address;
  });

  before(async function () {
    await hyperlaneCore1.deployOrUseExistingCore(HYP_KEY);

    // Create a new warp config using the example
    const exampleWarpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );
    hyp1Config = { [CHAIN_NAME_1]: { ...exampleWarpConfig.hyp1 } };
    writeYamlOrJson(WARP_CONFIG_PATH_1, hyp1Config);
  });

  describe('hyperlane warp read --config ...', () => {
    it('should exit early if no symbol or no chain and address', async () => {
      console.log('hit1');
      await hyperlaneWarp.deploy(WARP_CONFIG_PATH_1, HYP_KEY);
      console.log('hit2');

      const output = await hyperlaneWarp.readRaw({}).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.include(
        'Invalid input parameters. Please provide either a token symbol or both chain name and token address',
      );
    });
  });

  describe('hyperlane warp read --config ... --symbol ...', () => {
    it('should successfully read the complete warp route config from all the chains', async () => {
      await hyperlaneWarp.deploy(WARP_CONFIG_PATH_1, HYP_KEY);

      const output = await hyperlaneWarp
        .readRaw({
          symbol: 'ETH',
        })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);

      const warpReadResult: WarpRouteDeployConfig =
        readYamlOrJson(WARP_CONFIG_PATH_1);
      expect(warpReadResult[CHAIN_NAME_1]).not.to.be.undefined;
      expect(warpReadResult[CHAIN_NAME_1].type).to.equal(TokenType.native);
    });
  });

  describe('hyperlane warp read --symbol ...', () => {
    it('should successfully read the complete warp route config from all the chains', async () => {
      const readOutputPath = `${TEMP_PATH}/warp-read-all-chain-with-symbol.yaml`;

      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_1]: {
          type: TokenType.synthetic,
          mailbox: chain1Addresses.mailbox,
          owner: ownerAddress,
        },
        [CHAIN_NAME_2]: {
          type: TokenType.native,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarp.deploy(WARP_DEPLOY_OUTPUT_PATH, HYP_KEY);

      const steps: TestPromptAction[] = [
        // Select the hyp1-hyp2 HYP route from the selection prompt
        {
          check: (currentOutput: string) =>
            currentOutput.includes('Select from matching warp routes'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      const output = hyperlaneWarp
        .readRaw({
          symbol: 'HYP',
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
      await hyperlaneWarp.deploy(WARP_CONFIG_PATH_1, HYP_KEY, WARP_DEPLOY_1_ID);

      const warpReadResult: WarpRouteDeployConfig =
        await hyperlaneWarp.readConfig(CHAIN_NAME_1, WARP_CORE_CONFIG_PATH_1);

      expect(warpReadResult[CHAIN_NAME_1].type).to.be.equal(
        hyp1Config[CHAIN_NAME_1].type,
      );
    });
  });
});
