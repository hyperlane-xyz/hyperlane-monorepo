import { expect } from 'chai';
import sinon from 'sinon';

import {
  ISafe__factory,
  Ownable__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';

describe('resolveSubmitterBatchesForTransactions transaction field getter fallback', () => {
  const CHAIN = 'anvil2';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  it('falls back to jsonRpc when transaction target getter throws without running probes', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));

    const txWithThrowingTargetGetter = {
      ...TX,
      get to() {
        throw new Error('target getter should not crash inference');
      },
    };

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [txWithThrowingTargetGetter as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when transaction target exists only on prototype without running probes', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));
    const txWithInheritedTarget = Object.create({
      to: '0x1111111111111111111111111111111111111111',
    });
    txWithInheritedTarget.data = '0x';
    txWithInheritedTarget.chainId = 31338;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [txWithInheritedTarget as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('still infers gnosisSafeTxBuilder when transaction from getter throws but target owner is safe', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => safeOwner,
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').returns({
      getThreshold: async () => 1,
      nonce: async () => 0,
    } as any);

    const txWithThrowingFromGetter = {
      ...TX,
      get from() {
        throw new Error('from getter should not crash inference');
      },
    };

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [txWithThrowingFromGetter as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
            getSignerAddress: async () =>
              '0x4444444444444444444444444444444444444444',
            getProvider: () => ({}),
          },
          registry: {
            getAddresses: async () => ({}),
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(ownableStub.callCount).to.equal(1);
      expect(safeStub.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('falls back to jsonRpc when target is malformed and from getter throws', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('owner probe should not run for malformed target'));

    const txWithMalformedTargetAndThrowingFromGetter = {
      ...TX,
      to: 'not-an-evm-address',
      get from() {
        throw new Error('from getter should not crash inference');
      },
    };

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [txWithMalformedTargetAndThrowingFromGetter as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
    }
  });

  it('falls back to jsonRpc when target is malformed and transaction from exists only on prototype', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('owner probe should not run for malformed target'));
    const txWithInheritedFrom = Object.create({
      from: '0x2222222222222222222222222222222222222222',
    });
    txWithInheritedFrom.to = 'not-an-evm-address';
    txWithInheritedFrom.data = '0x';
    txWithInheritedFrom.chainId = 31338;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [txWithInheritedFrom as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
    }
  });

  it('falls back to jsonRpc when boxed transaction target toString throws without running probes', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));
    const boxedTarget = new String('0x1111111111111111111111111111111111111111') as any;
    boxedTarget.toString = () => {
      throw new Error('boxed target toString should not crash inference');
    };

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: boxedTarget } as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when target is malformed and boxed transaction from toString throws', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('owner probe should not run for malformed target'));
    const boxedFrom = new String('0x2222222222222222222222222222222222222222') as any;
    boxedFrom.toString = () => {
      throw new Error('boxed from toString should not crash inference');
    };

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: 'not-an-evm-address', from: boxedFrom } as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
    }
  });

  it('falls back to jsonRpc when boxed transaction target toString returns non-string without running probes', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));
    const boxedTarget = new String('0x1111111111111111111111111111111111111111') as any;
    boxedTarget.toString = () => 123 as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: boxedTarget } as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when target is malformed and boxed transaction from toString returns non-string', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('owner probe should not run for malformed target'));
    const boxedFrom = new String('0x2222222222222222222222222222222222222222') as any;
    boxedFrom.toString = () => 123 as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: 'not-an-evm-address', from: boxedFrom } as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
    }
  });

  it('falls back to jsonRpc when target is malformed and transaction from is overlong string', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('owner probe should not run for malformed target'));
    const overlongFrom = `0x${'2'.repeat(5000)}`;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: 'not-an-evm-address', from: overlongFrom } as any,
        ],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
    }
  });

  it('falls back to jsonRpc when target is malformed and boxed transaction from is overlong string', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('owner probe should not run for malformed target'));
    const boxedOverlongFrom = new String(`0x${'2'.repeat(5000)}`) as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: 'not-an-evm-address', from: boxedOverlongFrom } as any,
        ],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
    }
  });

  it('falls back to jsonRpc when target is malformed and transaction from contains null byte', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('owner probe should not run for malformed target'));
    const nullByteFrom = '0x2222222222222222222222222222222222222222\0';

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: 'not-an-evm-address', from: nullByteFrom } as any,
        ],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
    }
  });

  it('falls back to jsonRpc when target is malformed and boxed transaction from contains null byte', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('owner probe should not run for malformed target'));
    const boxedNullByteFrom = new String(
      '0x2222222222222222222222222222222222222222\0',
    ) as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: 'not-an-evm-address', from: boxedNullByteFrom } as any,
        ],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
    }
  });

  it('falls back to from-safe inference when owner() returns overlong value', async () => {
    const safeFrom = '0x3333333333333333333333333333333333333333';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => `0x${'4'.repeat(5000)}`,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== safeFrom.toLowerCase()) {
          throw new Error('unexpected safe probe target');
        }
        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      });
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run for safe from fallback'));

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, from: safeFrom } as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
            getSignerAddress: async () =>
              '0x4444444444444444444444444444444444444444',
            getProvider: () => ({}),
          },
          registry: {
            getAddresses: async () => ({}),
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect((batches[0].config.submitter as any).safeAddress.toLowerCase()).to.equal(
        safeFrom.toLowerCase(),
      );
      expect(ownableStub.callCount).to.equal(1);
      expect(safeStub.callCount).to.equal(1);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to from-safe inference when owner() returns null-byte value', async () => {
    const safeFrom = '0x3333333333333333333333333333333333333333';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => `0x4444444444444444444444444444444444444444\0`,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== safeFrom.toLowerCase()) {
          throw new Error('unexpected safe probe target');
        }
        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      });
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run for safe from fallback'));

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, from: safeFrom } as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
            getSignerAddress: async () =>
              '0x4444444444444444444444444444444444444444',
            getProvider: () => ({}),
          },
          registry: {
            getAddresses: async () => ({}),
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect((batches[0].config.submitter as any).safeAddress.toLowerCase()).to.equal(
        safeFrom.toLowerCase(),
      );
      expect(ownableStub.callCount).to.equal(1);
      expect(safeStub.callCount).to.equal(1);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when transaction target is cyclic-prototype proxy without running probes', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));

    let cyclicProxy: any;
    cyclicProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => cyclicProxy,
      },
    );

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: cyclicProxy } as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when transaction target is deep-prototype string-like object without running probes', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));

    let prototype: object = String.prototype;
    for (let i = 0; i < 200; i += 1) {
      prototype = Object.create(prototype);
    }
    const deepPrototypeStringLike = Object.create(prototype) as any;
    deepPrototypeStringLike.toString = () =>
      '0x1111111111111111111111111111111111111111';

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: deepPrototypeStringLike } as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when transaction target is overlong string without running probes', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));
    const overlongTarget = `0x${'1'.repeat(5000)}`;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: overlongTarget } as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when transaction target is getPrototypeOf-throwing proxy without running probes', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));
    const throwingPrototypeProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('prototype trap should not crash tx field normalization');
        },
      },
    );

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: throwingPrototypeProxy } as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when transaction target is forged String-prototype object without running probes', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));
    const forgedTarget = Object.create(String.prototype) as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: forgedTarget } as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });
});
