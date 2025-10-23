import { expect } from 'chai';
import { ethers } from 'ethers';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  IsmConfig,
  IsmType,
  WarpRouteDeployConfig,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';

import { writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { deployTestOffchainLookupISM } from '../commands/helpers.js';
import {
  hyperlaneWarpApplyRaw,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  TEMP_PATH,
  WARP_CORE_CONFIG_PATH_2,
  WARP_DEPLOY_2_ID,
} from '../consts.js';

const { TokenType } = AltVM;

describe('hyperlane warp apply E2E (ISM updates)', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  before(async function () {
    await deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY);
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
        owner: ANVIL_DEPLOYER_ADDRESS,
        paused: false,
      },
    },
    {
      description:
        'should allow updating the ism configuration to the default ism (0 address)',
      targetIsmConfig: ethers.constants.AddressZero,
      initialIsmConfig: {
        type: IsmType.PAUSABLE,
        owner: ANVIL_DEPLOYER_ADDRESS,
        paused: false,
      },
    },
    {
      description: 'should pause the pausable ISM',
      initialIsmConfig: {
        type: IsmType.PAUSABLE,
        owner: ANVIL_DEPLOYER_ADDRESS,
        paused: false,
      },
      targetIsmConfig: {
        type: IsmType.PAUSABLE,
        owner: ANVIL_DEPLOYER_ADDRESS,
        paused: true,
      },
    },
    {
      description: 'should update the offchain lookup ism',
      targetIsmConfig: {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: ANVIL_DEPLOYER_ADDRESS,
        urls: [
          'https://new-server.hyperlane.xyz/api',
          'https://backup-server.hyperlane.xyz/api',
        ],
      },
      initialIsmConfig: {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: ANVIL_DEPLOYER_ADDRESS,
        urls: ['https://server.hyperlane.xyz/api'],
      },
    },
    {
      description:
        'should update the offchain lookup ism if the urls are not in the same order',
      targetIsmConfig: {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: ANVIL_DEPLOYER_ADDRESS,
        urls: [
          'https://new-server.hyperlane.xyz/api',
          'https://backup-server.hyperlane.xyz/api',
        ],
      },
      initialIsmConfig: {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: ANVIL_DEPLOYER_ADDRESS,
        urls: [
          'https://backup-server.hyperlane.xyz/api',
          'https://new-server.hyperlane.xyz/api',
        ],
      },
    },
  ];

  for (const { description, targetIsmConfig, initialIsmConfig } of testCases) {
    it(description, async () => {
      const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

      // CLI does not support deploying offchain lookup isms so we do it here
      let ismDeployConfig = initialIsmConfig;
      if (
        typeof initialIsmConfig !== 'string' &&
        initialIsmConfig?.type === IsmType.OFFCHAIN_LOOKUP
      ) {
        const testOffchainLookupIsm = await deployTestOffchainLookupISM(
          ANVIL_KEY,
          CHAIN_NAME_2,
          initialIsmConfig.urls,
        );

        ismDeployConfig = testOffchainLookupIsm.address;
      }

      const warpDeployConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.native,
          owner: ANVIL_DEPLOYER_ADDRESS,
          interchainSecurityModule: ismDeployConfig,
        },
      };

      await writeYamlOrJson(warpDeployPath, warpDeployConfig);
      await hyperlaneWarpDeploy(warpDeployPath, WARP_DEPLOY_2_ID);

      // Write the updated config
      warpDeployConfig[CHAIN_NAME_2].interchainSecurityModule = targetIsmConfig;
      await writeYamlOrJson(warpDeployPath, warpDeployConfig);

      // Apply the changes
      await hyperlaneWarpApplyRaw({
        warpDeployPath: warpDeployPath,
        warpCorePath: WARP_CORE_CONFIG_PATH_2,
      });

      // Read back the config to verify changes
      const updatedConfig = await readWarpConfig(
        CHAIN_NAME_2,
        WARP_CORE_CONFIG_PATH_2,
        warpDeployPath,
      );

      expect(
        normalizeConfig(updatedConfig[CHAIN_NAME_2].interchainSecurityModule),
      ).to.deep.equal(normalizeConfig(targetIsmConfig));
    });
  }
});
