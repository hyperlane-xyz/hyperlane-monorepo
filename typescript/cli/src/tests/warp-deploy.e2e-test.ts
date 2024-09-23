import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import { TokenType, WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { writeYamlOrJson } from '../utils/files.js';

import {
  ANVIL_KEY,
  REGISTRY_PATH,
  deploy4626Vault,
  deployOrUseExistingCore,
  deployToken,
} from './commands/helpers.js';
import { hyperlaneWarpDeploy, readWarpConfig } from './commands/warp.js';

chai.use(chaiAsPromised);
chai.should();
const expect = chai.expect;

const CHAIN_NAME_2 = 'anvil2';
const CHAIN_NAME_3 = 'anvil3';

const EXAMPLES_PATH = './examples';
const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;
const WARP_CORE_CONFIG_PATH_2_3 = `${REGISTRY_PATH}/deployments/warp_routes/VAULT/anvil2-anvil3-config.yaml`;

const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh

const TEST_TIMEOUT = 60_000; // Long timeout since these tests can take a while
describe('WarpDeploy e2e tests', async function () {
  let chain2Addresses: ChainAddresses = {};
  this.timeout(TEST_TIMEOUT);
  before(async function () {
    chain2Addresses = await deployOrUseExistingCore(
      CHAIN_NAME_2,
      CORE_CONFIG_PATH,
      ANVIL_KEY,
    );
    await deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY);
  });

  it.only('should only allow rebasing yield route to be deployed with rebasing synthetic', async function () {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    const vault = await deploy4626Vault(ANVIL_KEY, CHAIN_NAME_2, token.address);
    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateralVaultRebase,
        token: vault.address,
        mailbox: chain2Addresses.mailbox,
        owner: chain2Addresses.mailbox,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain2Addresses.mailbox,
        owner: chain2Addresses.mailbox,
      },
    };

    writeYamlOrJson(warpConfigPath, warpConfig);
    await hyperlaneWarpDeploy(warpConfigPath).should.be.rejected;

    // Update to syntheticRebase
    warpConfig[CHAIN_NAME_3].type = TokenType.syntheticRebase;
    // @ts-ignore
    warpConfig[CHAIN_NAME_3].collateralDomain = 1;
    writeYamlOrJson(warpConfigPath, warpConfig);
    await hyperlaneWarpDeploy(warpConfigPath);

    // Check collateralRebase
    // const collateralRebaseConfig = (await readWarpConfig(
    //   CHAIN_NAME_2,
    //   WARP_CORE_CONFIG_PATH_2_3,
    //   warpConfigPath,
    // ))[CHAIN_NAME_2];

    // expect(collateralRebaseConfig.type).to.equal(
    //   TokenType.collateralVaultRebase,
    // );

    // Check syntheticRebase
    const syntheticRebaseConfig = (
      await readWarpConfig(
        CHAIN_NAME_3,
        WARP_CORE_CONFIG_PATH_2_3,
        warpConfigPath,
      )
    )[CHAIN_NAME_3];

    expect(syntheticRebaseConfig.type).to.equal(TokenType.syntheticRebase);
  });
});
