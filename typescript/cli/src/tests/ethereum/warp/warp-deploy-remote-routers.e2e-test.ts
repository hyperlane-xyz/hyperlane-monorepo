import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  TokenType,
  type WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  addressToBytes32,
  assert,
  isObjEmpty,
} from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH,
  getDomainId,
} from '../commands/helpers.js';
import {
  hyperlaneWarpDeploy,
  readWarpConfig,
  resolveWarpRouteIdForDeploy,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  IS_TRON_TEST,
  TRON_KEY_1,
  WARP_DEPLOY_OUTPUT_PATH,
} from '../consts.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

describe('hyperlane warp deploy with user-specified remote routers', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let ownerAddress: Address;
  let chain3DomainId: string;
  let chain4DomainId: string;

  before(async function () {
    ownerAddress = new Wallet(ANVIL_KEY).address;
    const chain3Key = IS_TRON_TEST ? TRON_KEY_1 : ANVIL_KEY;
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, chain3Key),
    ]);
    [chain3DomainId, chain4DomainId] = await Promise.all([
      getDomainId(CHAIN_NAME_3, ANVIL_KEY),
      getDomainId(CHAIN_NAME_4, ANVIL_KEY),
    ]);
  });

  it('should enroll user-specified remote routers for chains not in the deploy config', async function () {
    // Deploy only on anvil2 with remoteRouters pointing to anvil3 (not in deploy config)
    const fakeRemoteRouterAddress = randomAddress();

    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
        symbol: 'ETH',
        name: 'Ether',
        remoteRouters: {
          [CHAIN_NAME_3]: {
            address: addressToBytes32(fakeRemoteRouterAddress),
          },
        },
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    const resolvedWarpRouteId = await resolveWarpRouteIdForDeploy({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
    });

    const COMBINED_WARP_CORE_CONFIG_PATH =
      GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(WARP_DEPLOY_OUTPUT_PATH, 'ETH');

    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, resolvedWarpRouteId);

    // Read back the deployed config
    const deployedConfig = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      WARP_DEPLOY_OUTPUT_PATH,
    );

    // Verify the user-specified remote router was enrolled
    const remoteRouters = deployedConfig[CHAIN_NAME_2].remoteRouters;
    assert(remoteRouters, 'Expected remoteRouters to be defined');
    expect(Object.keys(remoteRouters)).to.include(chain3DomainId);
    expect(remoteRouters[chain3DomainId].address).to.equal(
      addressToBytes32(fakeRemoteRouterAddress),
    );
  });

  it('should enroll user-specified remote routers alongside routers from other deployed chains', async function () {
    // Deploy on both anvil2 and anvil3, but also specify a remote router
    // for anvil4 which is not part of the deployment
    const fakeRemoteRouterAddress = randomAddress();

    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
        symbol: 'ETH',
        name: 'Ether',
        remoteRouters: {
          [CHAIN_NAME_4]: {
            address: addressToBytes32(fakeRemoteRouterAddress),
          },
        },
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    const resolvedWarpRouteId = await resolveWarpRouteIdForDeploy({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
    });

    const COMBINED_WARP_CORE_CONFIG_PATH =
      GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(WARP_DEPLOY_OUTPUT_PATH, 'ETH');

    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, resolvedWarpRouteId);

    // Read back the deployed config for anvil2
    const deployedConfig = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      WARP_DEPLOY_OUTPUT_PATH,
    );

    const remoteRouters = deployedConfig[CHAIN_NAME_2].remoteRouters;
    assert(remoteRouters, 'Expected remoteRouters to be defined');

    // Should have both: the user-specified anvil4 AND the auto-discovered anvil3
    expect(Object.keys(remoteRouters)).to.include(chain4DomainId);
    expect(Object.keys(remoteRouters)).to.include(chain3DomainId);

    // Verify the user-specified address
    expect(remoteRouters[chain4DomainId].address).to.equal(
      addressToBytes32(fakeRemoteRouterAddress),
    );
  });

  it('should not enroll any remote routers when none are specified and only one chain is deployed', async function () {
    // Deploy only on anvil2 with NO remoteRouters
    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
        symbol: 'ETH',
        name: 'Ether',
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    const resolvedWarpRouteId = await resolveWarpRouteIdForDeploy({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
    });

    const COMBINED_WARP_CORE_CONFIG_PATH =
      GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(WARP_DEPLOY_OUTPUT_PATH, 'ETH');

    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, resolvedWarpRouteId);

    // Read back the deployed config
    const deployedConfig = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      WARP_DEPLOY_OUTPUT_PATH,
    );

    // Verify no remote routers were enrolled
    const remoteRouters = deployedConfig[CHAIN_NAME_2].remoteRouters;
    expect(
      !remoteRouters || isObjEmpty(remoteRouters),
      'Expected no remote routers to be enrolled',
    ).to.be.true;
  });
});
