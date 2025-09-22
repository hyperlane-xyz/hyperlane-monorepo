import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CHAIN_NAME_1,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_1,
  CORE_READ_CONFIG_PATH_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY,
  REGISTRY_PATH,
  WARP_CONFIG_PATH_1,
  WARP_CONFIG_PATH_EXAMPLE,
  WARP_CORE_CONFIG_PATH_1,
} from '../consts.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

describe('hyperlane warp apply e2e tests', async function () {
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

  // let chain1Addresses: ChainAddresses = {};
  // let chain2Addresses: ChainAddresses = {};

  // let ownerAddress: Address;

  before(async function () {
    // const wallet = await DirectSecp256k1Wallet.fromKey(
    //   Buffer.from(HYP_KEY, 'hex'),
    // );
    // const accounts = await wallet.getAccounts();
    // ownerAddress = accounts[0].address;

    await hyperlaneCore1.deploy(HYP_KEY);
    await hyperlaneCore2.deploy(HYP_KEY);

    // chain1Addresses = await hyperlaneCore1.deployOrUseExistingCore(HYP_KEY);
    // chain2Addresses = await hyperlaneCore2.deployOrUseExistingCore(HYP_KEY);
  });

  beforeEach(async function () {
    await hyperlaneWarp.deploy(WARP_CONFIG_PATH_EXAMPLE, HYP_KEY);
  });

  it.skip('should update the owner of the warp token', async () => {
    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );

    const NEW_OWNER = 'hyp1hvg7zsnrj6h29q9ss577mhrxa04rn94hv2cm2e';

    warpConfig.hyp1.owner = 'hyp1hvg7zsnrj6h29q9ss577mhrxa04rn94hv2cm2e';
    const hyp1Config = { hyp1: { ...warpConfig.hyp1 } };
    writeYamlOrJson(WARP_CONFIG_PATH_1, hyp1Config);

    await hyperlaneWarp.apply(
      HYP_KEY,
      WARP_CORE_CONFIG_PATH_1,
      WARP_CONFIG_PATH_EXAMPLE,
      'TEST/hyp1',
    );

    const updatedWarpDeployConfig1 = await hyperlaneWarp.readConfig(
      CHAIN_NAME_1,
      WARP_CORE_CONFIG_PATH_1,
    );

    expect(updatedWarpDeployConfig1.hyp1.owner).to.eq(NEW_OWNER);
  });
});
