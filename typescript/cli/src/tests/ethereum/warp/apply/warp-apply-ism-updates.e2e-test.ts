import { expect } from 'chai';
import { ethers } from 'ethers';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  IsmConfig,
  IsmType,
  WarpRouteDeployConfig,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  DEFAULT_EVM_WARP_CORE_PATH,
  DEFAULT_EVM_WARP_DEPLOY_PATH,
  DEFAULT_EVM_WARP_ID,
  DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../../constants.js';
import { deployTestOffchainLookupISM } from '../../commands/helpers.js';

const { TokenType } = AltVM;

describe('hyperlane warp apply E2E (ISM updates)', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  );

  before(async function () {
    await evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum);
  });

  const testCases: {
    description: string;
    initialIsmConfig?: IsmConfig;
    targetIsmConfig: IsmConfig;
  }[] = [
    {
      description: 'should allow updating the default ism to a new ism',
      // Use the default ism
      targetIsmConfig: {
        type: IsmType.PAUSABLE,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        paused: false,
      },
    },
    {
      description:
        'should allow updating the ism configuration to the default ism (0 address)',
      targetIsmConfig: ethers.constants.AddressZero,
      initialIsmConfig: {
        type: IsmType.PAUSABLE,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        paused: false,
      },
    },
    {
      description: 'should pause the pausable ISM',
      initialIsmConfig: {
        type: IsmType.PAUSABLE,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        paused: false,
      },
      targetIsmConfig: {
        type: IsmType.PAUSABLE,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        paused: true,
      },
    },
    {
      description: 'should update the offchain lookup ism',
      targetIsmConfig: {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        urls: [
          'https://new-server.hyperlane.xyz/api',
          'https://backup-server.hyperlane.xyz/api',
        ],
      },
      initialIsmConfig: {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        urls: ['https://server.hyperlane.xyz/api'],
      },
    },
    {
      description:
        'should update the offchain lookup ism if the urls are not in the same order',
      targetIsmConfig: {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        urls: [
          'https://new-server.hyperlane.xyz/api',
          'https://backup-server.hyperlane.xyz/api',
        ],
      },
      initialIsmConfig: {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        urls: [
          'https://backup-server.hyperlane.xyz/api',
          'https://new-server.hyperlane.xyz/api',
        ],
      },
    },
  ];

  for (const { description, targetIsmConfig, initialIsmConfig } of testCases) {
    it(description, async () => {
      // CLI does not support deploying offchain lookup isms so we do it here
      let ismDeployConfig = initialIsmConfig;
      if (
        typeof initialIsmConfig !== 'string' &&
        initialIsmConfig?.type === IsmType.OFFCHAIN_LOOKUP
      ) {
        const testOffchainLookupIsm = await deployTestOffchainLookupISM(
          HYP_KEY_BY_PROTOCOL.ethereum,
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          initialIsmConfig.urls,
          REGISTRY_PATH,
        );

        ismDeployConfig = testOffchainLookupIsm.address;
      }

      const warpDeployConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.native,
          owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
          interchainSecurityModule: ismDeployConfig,
        },
      };

      await writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);
      await evmWarpCommands.deploy(
        DEFAULT_EVM_WARP_DEPLOY_PATH,
        HYP_KEY_BY_PROTOCOL.ethereum,
        DEFAULT_EVM_WARP_ID,
      );

      // Write the updated config
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].interchainSecurityModule = targetIsmConfig;
      await writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

      // Apply the changes
      await evmWarpCommands.applyRaw({
        warpRouteId: DEFAULT_EVM_WARP_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      // Read back the config to verify changes
      const updatedConfig = await evmWarpCommands.readConfig(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        DEFAULT_EVM_WARP_CORE_PATH,
      );

      expect(
        normalizeConfig(
          updatedConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
            .interchainSecurityModule,
        ),
      ).to.deep.equal(normalizeConfig(targetIsmConfig));
    });
  }
});
