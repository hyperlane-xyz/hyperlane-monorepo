import { expect } from 'chai';
import sinon from 'sinon';

import {
  GasAction,
  MockSigner,
  ProtocolType,
} from '@hyperlane-xyz/provider-sdk';
import type { WarpArtifactConfig } from '@hyperlane-xyz/provider-sdk/warp';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import type { ChainMetadata } from '@hyperlane-xyz/sdk';

import { nativeBalancesAreSufficient } from './balances.js';

const SVM_CHAIN = 'svmtest';

// SVM-style metadata deliberately has NO gasPrice — the regression this test
// guards is that the WARP_DEPLOY_GAS path no longer bails out (or skips the
// chain) when gasPrice is absent.
const SVM_METADATA: ChainMetadata = {
  name: SVM_CHAIN,
  protocol: ProtocolType.Sealevel,
  domainId: 1399811149,
  chainId: '1399811149',
  nativeToken: { decimals: 9, name: 'SOL', symbol: 'SOL', denom: 'SOL' },
  rpcUrls: [{ http: 'http://127.0.0.1:8899' }],
};

const WARP_CONFIG: WarpArtifactConfig = {
  type: 'collateral',
  owner: '0xOwner',
  mailbox: '0xMailbox',
  token: '0xToken',
  remoteRouters: {},
  destinationGas: {},
};

describe('nativeBalancesAreSufficient — AltVM WARP_DEPLOY_GAS path', () => {
  afterEach(() => sinon.restore());

  it('consults getMinGasForWarpDeploy and reads the signer balance for a gasPrice-less chain', async () => {
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getProtocol.returns(ProtocolType.Sealevel);
    multiProvider.getChainMetadata.returns(SVM_METADATA);

    const signer = new MockSigner();
    sinon.stub(signer, 'getSignerAddress').returns('svmDeployer');
    const getMinGasStub = sinon
      .stub(signer, 'getMinGasForWarpDeploy')
      .resolves(2_600_000_000n);
    // Deployer is funded above the required amount, so the success path runs
    // without prompting for confirmation.
    const getBalanceStub = sinon
      .stub(signer, 'getBalance')
      .resolves(50_000_000_000n);

    await nativeBalancesAreSufficient(
      multiProvider,
      { [SVM_CHAIN]: signer },
      [SVM_CHAIN],
      GasAction.WARP_DEPLOY_GAS,
      true,
      { [SVM_CHAIN]: WARP_CONFIG },
    );

    expect(getMinGasStub.calledOnceWith(WARP_CONFIG)).to.equal(true);
    expect(
      getBalanceStub.calledOnceWith({ address: 'svmDeployer', denom: 'SOL' }),
    ).to.equal(true);
  });
});
