import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';
import { runAnvilNode, runCosmosNode } from '../../nodes.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

describe('hyperlane warp deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let cosmosNativeChain1CoreAddress: ChainAddresses;
  const cosmosNativeChain1Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.cosmosnative,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
  );

  let evmChain1CoreCoreAddress: ChainAddresses;
  const evmChain1Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  before(async function () {
    await runCosmosNode();
    // TODO: parametrize this
    await runAnvilNode(8555, 31338);

    [cosmosNativeChain1CoreAddress, evmChain1CoreCoreAddress] =
      await Promise.all([
        cosmosNativeChain1Core.deployOrUseExistingCore(
          HYP_KEY_BY_PROTOCOL.cosmosnative,
        ),
        evmChain1Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      ]);
  });

  it('should do something', () => {
    console.log(evmChain1CoreCoreAddress, cosmosNativeChain1CoreAddress);
    expect(0).to.eql(0);
  });
});
