import { expect } from 'chai';

import {
  type ChainMetadata,
  type CoreConfig,
  HyperlaneSmartProvider,
  LocalAccountViemSigner,
  type ProtocolFeeHookConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, ProtocolType, ensure0x } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from '../consts.js';

describe('hyperlane core read e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_2,
  );

  let signer: ReturnType<LocalAccountViemSigner['connect']>;
  let initialOwnerAddress: Address;

  before(async () => {
    const chainMetadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);

    const provider = HyperlaneSmartProvider.fromRpcUrl(
      chainMetadata.chainId,
      chainMetadata.rpcUrls[0].http,
    );
    const wallet = new LocalAccountViemSigner(ensure0x(ANVIL_KEY));
    signer = wallet.connect(provider);

    initialOwnerAddress = await signer.getAddress();
  });

  it('should read a core deployment', async () => {
    await hyperlaneCore.deploy(ANVIL_KEY);

    const coreConfig: CoreConfig = await hyperlaneCore.readConfig();

    expect(coreConfig.owner).to.equal(initialOwnerAddress);
    expect(coreConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
    expect(coreConfig.requiredHook).not.to.be.undefined;
    expect(coreConfig.defaultHook).not.to.be.undefined;
    expect(coreConfig.defaultIsm).not.to.be.undefined;
    // Assuming that the ProtocolFeeHook is used for deployment
    expect((coreConfig.requiredHook as ProtocolFeeHookConfig).owner).to.equal(
      initialOwnerAddress,
    );
  });
});
