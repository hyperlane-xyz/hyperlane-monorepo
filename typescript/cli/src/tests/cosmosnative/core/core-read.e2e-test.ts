import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { expect } from 'chai';

import { CosmosNativeSigner } from '@hyperlane-xyz/cosmos-sdk';
import {
  ChainMetadata,
  CoreConfig,
  IgpConfig,
  ProtocolReceipt,
  ProtocolTransaction,
} from '@hyperlane-xyz/sdk';
import { Address, AltVM, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CHAIN_1_METADATA_PATH,
  CHAIN_NAME_1,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_1,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY,
  REGISTRY_PATH,
} from '../consts.js';

describe('hyperlane cosmosnative core read e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_1,
  );

  let signer: AltVM.ISigner<
    ProtocolTransaction<ProtocolType.CosmosNative>,
    ProtocolReceipt<ProtocolType.CosmosNative>
  >;
  let initialOwnerAddress: Address;

  before(async () => {
    const chainMetadata: ChainMetadata = readYamlOrJson(CHAIN_1_METADATA_PATH);

    const wallet = await DirectSecp256k1Wallet.fromKey(
      Uint8Array.from(Buffer.from(HYP_KEY, 'hex')),
      'hyp',
    );

    assert(chainMetadata.gasPrice, 'gasPrice not defined in chain metadata');

    signer = await CosmosNativeSigner.connectWithSigner(
      chainMetadata.rpcUrls.map((rpc) => rpc.http),
      wallet,
      {
        metadata: chainMetadata,
      },
    );

    initialOwnerAddress = signer.getSignerAddress();
  });

  it('should read a core deployment', async () => {
    await hyperlaneCore.deploy(HYP_KEY);

    const coreConfig: CoreConfig = await hyperlaneCore.readConfig();

    expect(coreConfig.owner).to.equal(initialOwnerAddress);
    expect(coreConfig.proxyAdmin?.owner).to.be.undefined;
    expect(coreConfig.requiredHook).not.to.be.undefined;
    expect(coreConfig.defaultHook).not.to.be.undefined;
    expect(coreConfig.defaultIsm).not.to.be.undefined;
    // Assuming that the IgpConfig is used for deployment
    expect((coreConfig.defaultHook as IgpConfig).owner).to.equal(
      initialOwnerAddress,
    );
  });
});
