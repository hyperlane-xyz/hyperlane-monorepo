import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  HookConfig,
  HookType,
  IsmConfig,
  IsmType,
  TokenType,
  WarpRouteDeployConfig,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';

import { WarpSendLogs } from '../send/transfer.js';
import { writeYamlOrJson } from '../utils/files.js';

import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
  deploy4626Vault,
  deployOrUseExistingCore,
  deployToken,
  sendWarpRouteMessageRoundTrip,
} from './commands/helpers.js';
import {
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
  readWarpConfig,
} from './commands/warp.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

const WARP_CONFIG_PATH = `${TEMP_PATH}/warp-route-deployment-deploy.yaml`;
const WARP_CORE_CONFIG_PATH_2_3 = `${REGISTRY_PATH}/deployments/warp_routes/VAULT/anvil2-anvil3-config.yaml`;

describe('hyperlane warp deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let token: any;
  let vault: any;

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

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

  it('should deploy with an ISM config', async () => {
    // 1. Define ISM configuration
    const ism: IsmConfig = {
      type: IsmType.MESSAGE_ID_MULTISIG,
      validators: [chain2Addresses.mailbox], // Using mailbox address as example validator
      threshold: 1,
    };

    // 2. Create Warp configuration with ISM
    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateralVaultRebase,
        token: vault.address,
        mailbox: chain2Addresses.mailbox,
        owner: chain2Addresses.mailbox,
        interchainSecurityModule: ism, // Add ISM config here
      },
      [CHAIN_NAME_3]: {
        type: TokenType.syntheticRebase,
        mailbox: chain3Addresses.mailbox,
        owner: chain3Addresses.mailbox,
        collateralChainName: CHAIN_NAME_2,
      },
    };

    // 3. Write config and deploy
    writeYamlOrJson(WARP_CONFIG_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH);

    // 4. Verify deployed ISM configuration
    const collateralRebaseConfig = (
      await readWarpConfig(
        CHAIN_NAME_2,
        WARP_CORE_CONFIG_PATH_2_3,
        WARP_CONFIG_PATH,
      )
    )[CHAIN_NAME_2];

    expect(
      normalizeConfig(collateralRebaseConfig.interchainSecurityModule),
    ).to.deep.equal(normalizeConfig(ism));
  });

  it('should deploy with a hook config', async () => {
    const hook: HookConfig = {
      type: HookType.PROTOCOL_FEE,
      beneficiary: chain2Addresses.mailbox,
      owner: chain2Addresses.mailbox,
      maxProtocolFee: '1337',
      protocolFee: '1337',
    };
    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateralVaultRebase,
        token: vault.address,
        mailbox: chain2Addresses.mailbox,
        owner: chain2Addresses.mailbox,
        hook,
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

    expect(normalizeConfig(collateralRebaseConfig.hook)).to.deep.equal(
      normalizeConfig(hook),
    );
  });

  it('should send a message from origin to destination in the correct order', async function () {
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

    // Try to send a transaction with the origin destination
    const { stdout: chain2Tochain3Stdout } = await hyperlaneWarpSendRelay(
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      WARP_CORE_CONFIG_PATH_2_3,
    );
    expect(chain2Tochain3Stdout).to.include('anvil2 ➡️ anvil3');

    // Send another message with swapped origin destination
    const { stdout: chain3Tochain2Stdout } = await hyperlaneWarpSendRelay(
      CHAIN_NAME_3,
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2_3,
    );
    expect(chain3Tochain2Stdout).to.include('anvil3 ➡️ anvil2');

    // Should throw if invalid origin or destination
    await hyperlaneWarpSendRelay(
      'anvil1',
      CHAIN_NAME_3,
      WARP_CORE_CONFIG_PATH_2_3,
    ).should.be.rejectedWith(
      'Error: Origin (anvil1) or destination (anvil3) are not part of the warp route.',
    );
  });
});
