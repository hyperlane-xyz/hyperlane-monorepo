import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import { TokenType, WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { WarpSendLogs } from '../send/transfer.js';
import { writeYamlOrJson } from '../utils/files.js';

import {
  ANVIL_KEY,
  REGISTRY_PATH,
  deploy4626Vault,
  deployOrUseExistingCore,
  deployToken,
  sendWarpRouteMessageRoundTrip,
} from './commands/helpers.js';
import { hyperlaneWarpDeploy, readWarpConfig } from './commands/warp.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

const CHAIN_NAME_2 = 'anvil2';
const CHAIN_NAME_3 = 'anvil3';

const EXAMPLES_PATH = './examples';
const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh

const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;
const WARP_CONFIG_PATH = `${TEMP_PATH}/warp-route-deployment-deploy.yaml`;
const WARP_CORE_CONFIG_PATH_2_3 = `${REGISTRY_PATH}/deployments/warp_routes/VAULT/anvil2-anvil3-config.yaml`;

const TEST_TIMEOUT = 60_000; // Long timeout since these tests can take a while
describe('WarpDeploy e2e tests', async function () {
  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let token: any;
  let vault: any;

  this.timeout(TEST_TIMEOUT);

  before(async function () {
    chain2Addresses = await deployOrUseExistingCore(
      CHAIN_NAME_2,
      CORE_CONFIG_PATH,
      ANVIL_KEY,
    );

    chain3Addresses = await deployOrUseExistingCore(
      CHAIN_NAME_3,
      CORE_CONFIG_PATH,
      ANVIL_KEY,
    );

    token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    vault = await deploy4626Vault(ANVIL_KEY, CHAIN_NAME_2, token.address);
  });

  it('should only allow rebasing yield route to be deployed with rebasing synthetic', async function () {
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

    writeYamlOrJson(WARP_CONFIG_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH).should.be.rejected; // TODO: revisit this to figure out how to parse the error.
  });

  it(`should be able to bridge between ${TokenType.collateralVaultRebase} and ${TokenType.syntheticRebase}`, async function () {
    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateralVaultRebase,
        token: vault.address,
        mailbox: chain2Addresses.mailbox,
        owner: chain2Addresses.mailbox,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.syntheticRebase,
        mailbox: chain3Addresses.mailbox,
        owner: chain3Addresses.mailbox,
        collateralChainName: CHAIN_NAME_2,
      },
    };

    writeYamlOrJson(WARP_CONFIG_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH);

    // Check collateralRebase
    const collateralRebaseConfig = (
      await readWarpConfig(
        CHAIN_NAME_2,
        WARP_CORE_CONFIG_PATH_2_3,
        WARP_CONFIG_PATH,
      )
    )[CHAIN_NAME_2];

    expect(collateralRebaseConfig.type).to.equal(
      TokenType.collateralVaultRebase,
    );

    // Try to send a transaction
    const { stdout } = await sendWarpRouteMessageRoundTrip(
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      WARP_CORE_CONFIG_PATH_2_3,
    );
    expect(stdout).to.include(WarpSendLogs.SUCCESS);
  });
});
