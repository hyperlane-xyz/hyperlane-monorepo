import { expect } from 'chai';
import { Wallet } from 'ethers';

import { ERC20Test } from '@hyperlane-xyz/core';
import {
  ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  HookConfig,
  IsmConfig,
  IsmType,
  MUTABLE_HOOK_TYPE,
  MUTABLE_ISM_TYPE,
  TokenType,
  WarpRouteDeployConfig,
  randomAddress,
  randomHookConfig,
  randomIsmConfig,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, assert, deepCopy } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  WARP_DEPLOY_OUTPUT_PATH,
  getWarpCoreConfigPath,
} from '../../constants.js';
import { deployToken } from '../commands/helpers.js';

describe('hyperlane warp check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let token: ERC20Test;
  let tokenSymbol: string;
  let ownerAddress: Address;
  let combinedWarpCoreConfigPath: string;
  let warpConfig: WarpRouteDeployConfig;

  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );
  const evmChain3Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    WARP_DEPLOY_OUTPUT_PATH,
  );

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      evmChain3Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);

    token = await deployToken(
      HYP_KEY_BY_PROTOCOL.ethereum,
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    );
    tokenSymbol = await token.symbol();

    combinedWarpCoreConfigPath = getWarpCoreConfigPath(tokenSymbol, [
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    ]);
  });

  async function deployAndExportWarpRoute(): Promise<WarpRouteDeployConfig> {
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    // currently warp deploy is not writing the deploy config to the registry
    // should remove this once the deploy config is written to the registry
    writeYamlOrJson(
      combinedWarpCoreConfigPath.replace('-config.yaml', '-deploy.yaml'),
      warpConfig,
    );

    const currentWarpId = createWarpRouteConfigId(
      await token.symbol(),
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    );

    await evmWarpCommands.deploy(
      WARP_DEPLOY_OUTPUT_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
      currentWarpId,
    );

    return warpConfig;
  }

  // Reset config before each test to avoid test changes intertwining
  beforeEach(async function () {
    ownerAddress = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address;
    warpConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: token.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };
  });

  for (const hookType of MUTABLE_HOOK_TYPE) {
    it(`should find owner differences between the local config and the on chain config for hook of type ${hookType}`, async function () {
      warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].hook =
        randomHookConfig(0, 2, hookType);
      await deployAndExportWarpRoute();

      const mutatedWarpConfig = deepCopy(warpConfig);

      const hookConfig: Extract<
        HookConfig,
        { type: (typeof MUTABLE_HOOK_TYPE)[number]; owner: string }
      > =
        mutatedWarpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .hook!;
      const actualOwner = hookConfig.owner;
      const wrongOwner = randomAddress();
      assert(actualOwner !== wrongOwner, 'Random owner matches actualOwner');
      hookConfig.owner = wrongOwner;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, mutatedWarpConfig);

      const expectedDiffText = `EXPECTED: "${wrongOwner.toLowerCase()}"\n`;
      const expectedActualText = `ACTUAL: "${actualOwner.toLowerCase()}"\n`;

      const output = await evmWarpCommands
        .checkRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
          warpCoreConfigPath: combinedWarpCoreConfigPath,
        })
        .nothrow();
      expect(output.exitCode).to.equal(1);
      expect(output.text().includes(expectedDiffText)).to.be.true;
      expect(output.text().includes(expectedActualText)).to.be.true;
    });
  }

  // Removing the offchain lookup ism because it is a family of different isms
  for (const ismType of MUTABLE_ISM_TYPE.filter(
    (ismType) => ismType !== IsmType.OFFCHAIN_LOOKUP,
  )) {
    it(`should find owner differences between the local config and the on chain config for ism of type ${ismType}`, async function () {
      // Create a Pausable because randomIsmConfig() cannot generate it (reason: NULL type Isms)
      warpConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].interchainSecurityModule =
        ismType === IsmType.PAUSABLE
          ? {
              type: IsmType.PAUSABLE,
              owner: randomAddress(),
              paused: true,
            }
          : randomIsmConfig(0, 2, ismType);
      await deployAndExportWarpRoute();

      const mutatedWarpConfig = deepCopy(warpConfig);

      const ismConfig: Extract<
        IsmConfig,
        { type: (typeof MUTABLE_ISM_TYPE)[number]; owner: string }
      > =
        mutatedWarpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .interchainSecurityModule;
      const actualOwner = ismConfig.owner;
      const wrongOwner = randomAddress();
      assert(actualOwner !== wrongOwner, 'Random owner matches actualOwner');
      ismConfig.owner = wrongOwner;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, mutatedWarpConfig);

      const expectedDiffText = `EXPECTED: "${wrongOwner.toLowerCase()}"\n`;
      const expectedActualText = `ACTUAL: "${actualOwner.toLowerCase()}"\n`;

      const output = await evmWarpCommands
        .checkRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
          warpCoreConfigPath: combinedWarpCoreConfigPath,
        })
        .nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text().includes(expectedDiffText)).to.be.true;
      expect(output.text().includes(expectedActualText)).to.be.true;
    });
  }
});
