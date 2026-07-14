import { expect } from 'chai';
import sinon from 'sinon';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmWarpModule } from './EvmWarpModule.js';
import { EvmXERC20Module } from './EvmXERC20Module.js';
import { TokenType } from './config.js';
import {
  DerivedTokenRouterConfig,
  HypTokenRouterConfig,
  XERC20Type,
} from './types.js';

const TOKEN_ADDRESS = '0x1111111111111111111111111111111111111111';
const MAILBOX_ADDRESS = '0x2222222222222222222222222222222222222222';
const OWNER_ADDRESS = '0x3333333333333333333333333333333333333333';
const ROUTER_ADDRESS = '0x4444444444444444444444444444444444444444';

// Sentinel thrown by the createTokenFeeUpdateTxs stub to short-circuit
// updateSplit immediately after the module.update() call, so the test does not
// need to stub the ~20 downstream create*UpdateTxs helpers.
class ShortCircuit extends Error {}

describe('EvmWarpModule', () => {
  let multiProvider: MultiProvider;
  let sandbox: sinon.SinonSandbox;

  const xERC20Config: HypTokenRouterConfig = {
    type: TokenType.XERC20,
    token: TOKEN_ADDRESS,
    mailbox: MAILBOX_ADDRESS,
    owner: OWNER_ADDRESS,
    xERC20: {
      warpRouteLimits: {
        type: XERC20Type.Standard,
        mint: '1000000000000000000',
        burn: '1000000000000000000',
      },
    },
  };

  beforeEach(() => {
    multiProvider = MultiProvider.createTestMultiProvider();
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  // Locks the ownership gate at the real caller. updateSplit must invoke
  // module.update(config) WITHOUT { includeOwnership: true }, so the warp
  // apply/read path never emits XERC20 ownership-transfer txs. Asserting only at
  // the EvmXERC20Module level would stay green if someone flipped this call site.
  it('calls XERC20 module.update without includeOwnership from updateSplit', async () => {
    const updateStub = sandbox
      .stub(EvmXERC20Module.prototype, 'update')
      .resolves([]);

    // read() output is unused before the short-circuit; stub it to avoid network.
    sandbox
      .stub(EvmWarpModule.prototype, 'read')
      // CAST: value is never inspected before createTokenFeeUpdateTxs throws.
      .resolves({} as DerivedTokenRouterConfig);

    sandbox
      .stub(EvmWarpModule.prototype, 'createTokenFeeUpdateTxs')
      .rejects(new ShortCircuit());

    const module = new EvmWarpModule(
      multiProvider,
      // CAST: only deployedTokenRoute is read before the short-circuit; the
      // proxy-factory addresses in WarpRouteAddresses are never touched.
      {
        chain: TestChainName.test1,
        config: xERC20Config,
        addresses: { deployedTokenRoute: ROUTER_ADDRESS },
      } as ConstructorParameters<typeof EvmWarpModule>[1],
    );

    try {
      await module.updateSplit(xERC20Config);
      expect.fail('expected updateSplit to short-circuit via ShortCircuit');
    } catch (error) {
      expect(error).to.be.instanceOf(ShortCircuit);
    }

    expect(updateStub.calledOnce).to.equal(true);
    expect(updateStub.firstCall.args).to.have.length(1);
    expect(updateStub.firstCall.args[1]).to.equal(undefined);
  });
});
