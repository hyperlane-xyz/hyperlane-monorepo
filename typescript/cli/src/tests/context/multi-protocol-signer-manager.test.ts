import { expect } from 'chai';
import sinon from 'sinon';

import {
  MultiProtocolProvider,
  TxSubmitterType,
  test1,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProtocolSignerManager } from '../../context/strategies/signer/MultiProtocolSignerManager.js';
import { MultiProtocolSignerFactory } from '../../context/strategies/signer/MultiProtocolSignerFactory.js';
import { ANVIL_KEY } from '../ethereum/consts.js';

describe('MultiProtocolSignerManager strategy lookup hardening', () => {
  const CHAIN = 'test1';

  afterEach(() => {
    sinon.restore();
  });

  it('ignores inherited chain strategy entries when initializing signers', async () => {
    const inheritedStrategy = Object.create({
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
          privateKey: `0x${'1'.repeat(64)}`,
        },
      },
    });

    const getSignerStub = sinon.stub().resolves({} as any);
    sinon
      .stub(MultiProtocolSignerFactory, 'getSignerStrategy')
      .returns({ getSigner: getSignerStub } as any);

    await MultiProtocolSignerManager.init(
      inheritedStrategy as any,
      [CHAIN],
      new MultiProtocolProvider({ [CHAIN]: test1 }),
      { key: { [ProtocolType.Ethereum]: ANVIL_KEY } },
    );

    expect(getSignerStub.calledOnce).to.equal(true);
    expect(getSignerStub.firstCall.args[0].chain).to.equal(CHAIN);
    expect(getSignerStub.firstCall.args[0].privateKey).to.equal(ANVIL_KEY);
  });

  it('ignores inherited submitter entries for own chain strategy objects', async () => {
    const chainStrategy = Object.create({
      submitter: {
        type: TxSubmitterType.JSON_RPC,
        chain: CHAIN,
        privateKey: `0x${'2'.repeat(64)}`,
      },
    });
    const strategy = {
      [CHAIN]: chainStrategy,
    };

    const getSignerStub = sinon.stub().resolves({} as any);
    sinon
      .stub(MultiProtocolSignerFactory, 'getSignerStrategy')
      .returns({ getSigner: getSignerStub } as any);

    await MultiProtocolSignerManager.init(
      strategy as any,
      [CHAIN],
      new MultiProtocolProvider({ [CHAIN]: test1 }),
      { key: { [ProtocolType.Ethereum]: ANVIL_KEY } },
    );

    expect(getSignerStub.calledOnce).to.equal(true);
    expect(getSignerStub.firstCall.args[0].privateKey).to.equal(ANVIL_KEY);
  });

  it('uses own chain submitter strategy when present', async () => {
    const strategy = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
          privateKey: `0x${'3'.repeat(64)}`,
        },
      },
    };

    const getSignerStub = sinon.stub().resolves({} as any);
    sinon
      .stub(MultiProtocolSignerFactory, 'getSignerStrategy')
      .returns({ getSigner: getSignerStub } as any);

    await MultiProtocolSignerManager.init(
      strategy as any,
      [CHAIN],
      new MultiProtocolProvider({ [CHAIN]: test1 }),
      { key: { [ProtocolType.Ethereum]: ANVIL_KEY } },
    );

    expect(getSignerStub.calledOnce).to.equal(true);
    expect(getSignerStub.firstCall.args[0].privateKey).to.equal(
      strategy[CHAIN].submitter.privateKey,
    );
  });
});
