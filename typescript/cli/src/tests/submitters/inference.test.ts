import { tmpdir } from 'os';

import { expect } from 'chai';
import sinon from 'sinon';
import { constants as ethersConstants } from 'ethers';

import {
  ISafe__factory,
  InterchainAccountRouter__factory,
  Ownable__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions', () => {
  const CHAIN = 'anvil2';
  const SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  it('returns no batches when no transactions are provided', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
    });

    expect(batches).to.deep.equal([]);
  });

  it('uses explicit strategy when provided', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any, TX as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(batches[0].transactions).to.have.length(2);
  });

  it('uses explicit default submitter when protocol lookup fails', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-failure-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x3333333333333333333333333333333333333333',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any, { ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            throw new Error('missing chain metadata');
          },
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(batches[0].transactions).to.have.length(2);
  });

  it('falls back to jsonRpc when protocol lookup fails without explicit strategy', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            throw new Error('missing chain metadata');
          },
        },
      } as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('reuses protocol lookup for inferred transaction batches', async () => {
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => SIGNER,
    } as any);

    let protocolCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => {
          protocolCalls += 1;
          return ProtocolType.Ethereum;
        },
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(protocolCalls).to.equal(1);
    } finally {
      ownableStub.restore();
    }
  });

  it('handles bigint-like explicit submitter fields in fingerprinting', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-timelock-delay-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.TIMELOCK_CONTROLLER,
          chain: CHAIN,
          timelockAddress: '0x3333333333333333333333333333333333333333',
          delay: 0,
          proposerSubmitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('falls back to inference when strategy file has no config for chain', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-missing-chain-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      anvil3: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: 'anvil3',
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
      },
    });

    const safeOwner = '0x2222222222222222222222222222222222222222';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => safeOwner,
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeOwner.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
        strategyUrl: strategyPath,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('routes transactions using explicit per-target submitter overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-overrides-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txDefault = TX;
    const txOverride = { ...TX, to: overrideTarget };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txDefault as any, txOverride as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(2);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[1].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('matches explicit target-only override with mixed-case target address', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-overrides-target-case-${Date.now()}.yaml`;
    const overrideTargetMixedCase = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTargetMixedCase]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txOverride = { ...TX, to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txOverride as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('keeps first target-only override when normalized EVM targets collide', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-overrides-target-collision-${Date.now()}.yaml`;
    const normalizedTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const mixedCaseTarget = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';

    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [mixedCaseTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x1111111111111111111111111111111111111111',
            version: '1.0',
          },
          [normalizedTarget]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x2222222222222222222222222222222222222222',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const tx = { ...TX, to: normalizedTarget };
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [tx as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('matches explicit EVM override when transaction target has whitespace', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-overrides-target-whitespace-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txOverride = { ...TX, to: `  ${overrideTarget}  ` };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txOverride as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('matches explicit EVM override when transaction target has uppercase 0X prefix', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-overrides-target-upper-prefix-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txOverride = { ...TX, to: '  0Xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ' };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txOverride as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('matches explicit EVM override when override key has uppercase 0X prefix', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-overrides-key-upper-prefix-${Date.now()}.yaml`;
    const overrideTargetLower = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          '0Xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txOverride = { ...TX, to: overrideTargetLower };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txOverride as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves transaction order by splitting non-contiguous explicit submitter matches', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-overrides-order-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txDefaultFirst = { ...TX, to: '0x1111111111111111111111111111111111111111' };
    const txOverride = { ...TX, to: overrideTarget };
    const txDefaultLast = { ...TX, to: '0x2222222222222222222222222222222222222222' };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [
        txDefaultFirst as any,
        txOverride as any,
        txDefaultLast as any,
      ],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(3);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[1].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(batches[2].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[0].transactions).to.deep.equal([txDefaultFirst as any]);
    expect(batches[1].transactions).to.deep.equal([txOverride as any]);
    expect(batches[2].transactions).to.deep.equal([txDefaultLast as any]);
  });

  it('coalesces adjacent explicit submitter matches into single batches', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-overrides-adjacent-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txDefaultFirst = { ...TX, to: '0x1111111111111111111111111111111111111111' };
    const txDefaultSecond = {
      ...TX,
      to: '0x2222222222222222222222222222222222222222',
    };
    const txOverrideFirst = { ...TX, to: overrideTarget };
    const txOverrideSecond = {
      ...TX,
      to: overrideTarget,
      data: '0xdeadbeef',
    };
    const txDefaultLast = { ...TX, to: '0x3333333333333333333333333333333333333333' };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [
        txDefaultFirst as any,
        txDefaultSecond as any,
        txOverrideFirst as any,
        txOverrideSecond as any,
        txDefaultLast as any,
      ],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(3);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[1].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(batches[2].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[0].transactions).to.deep.equal([
      txDefaultFirst as any,
      txDefaultSecond as any,
    ]);
    expect(batches[1].transactions).to.deep.equal([
      txOverrideFirst as any,
      txOverrideSecond as any,
    ]);
    expect(batches[2].transactions).to.deep.equal([txDefaultLast as any]);
  });

  it('prioritizes selector-specific override over target override', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-overrides-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x7777777777777777777777777777777777777777',
            version: '1.0',
          },
          [`${overrideTarget}@0xdeadbeef`]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x6666666666666666666666666666666666666666',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const txWithSelector = {
      ...TX,
      to: overrideTarget,
      data: '0xdeadbeef0000',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithSelector as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('keeps first selector-specific override when normalized selector keys collide', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-collision-${Date.now()}.yaml`;
    const target = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const selector = '0xdeadbeef';

    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [`0XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@0XDEADBEEF`]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x3333333333333333333333333333333333333333',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
          [`${target}@${selector}`]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x4444444444444444444444444444444444444444',
            version: '1.0',
          },
        },
      },
    });

    const tx = {
      ...TX,
      to: target,
      data: `${selector}0000`,
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [tx as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('uses target-only override when selector-specific override does not match', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-miss-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x7777777777777777777777777777777777777777',
            version: '1.0',
          },
          [`${overrideTarget}@0xdeadbeef`]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x6666666666666666666666666666666666666666',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const txWithDifferentSelector = {
      ...TX,
      to: overrideTarget,
      data: '0xfeedface0000',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithDifferentSelector as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('ignores malformed selector override keys with extra separators', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-malformed-key-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x7777777777777777777777777777777777777777',
            version: '1.0',
          },
          [`${overrideTarget}@0xdeadbeef@extra`]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x6666666666666666666666666666666666666666',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const txWithSelector = {
      ...TX,
      to: overrideTarget,
      data: '0xdeadbeef0000',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithSelector as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('matches selector-specific override keys with whitespace padding', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-whitespace-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [`  ${overrideTarget}  @  0xdeadbeef  `]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x6666666666666666666666666666666666666666',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const txWithSelector = {
      ...TX,
      to: overrideTarget,
      data: '0xdeadbeef0000',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithSelector as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('matches selector-specific override when tx data selector is uppercase', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-uppercase-data-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [`${overrideTarget}@0xdeadbeef`]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x6666666666666666666666666666666666666666',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const txWithUppercaseSelector = {
      ...TX,
      to: overrideTarget,
      data: '0xDEADBEEF0000',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithUppercaseSelector as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('matches selector-specific override when tx data has whitespace padding', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-data-whitespace-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [`${overrideTarget}@0xdeadbeef`]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x6666666666666666666666666666666666666666',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const txWithWhitespaceSelector = {
      ...TX,
      to: overrideTarget,
      data: '  0xdeadbeef0000  ',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithWhitespaceSelector as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('matches selector-specific override when tx data has uppercase 0X prefix', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-uppercase-prefix-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [`${overrideTarget}@0xdeadbeef`]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x6666666666666666666666666666666666666666',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const txWithUppercasePrefix = {
      ...TX,
      to: overrideTarget,
      data: '  0XDEADBEEF0000  ',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithUppercasePrefix as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('matches selector-specific override when key target has uppercase 0X prefix', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-key-upper-prefix-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          '0Xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@0xdeadbeef': {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x6666666666666666666666666666666666666666',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const txWithSelector = {
      ...TX,
      to: overrideTarget,
      data: '0xdeadbeef0000',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithSelector as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('matches selector-specific override when key selector has uppercase 0X prefix', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-key-selector-upper-prefix-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [`${overrideTarget}@0XDEADBEEF`]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x6666666666666666666666666666666666666666',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const txWithSelector = {
      ...TX,
      to: overrideTarget,
      data: '0xdeadbeef0000',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithSelector as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('ignores invalid override keys and falls back to default explicit submitter', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-invalid-overrides-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          'not-an-address@invalid-selector': {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x7777777777777777777777777777777777777777',
            version: '1.0',
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('ignores invalid EVM override target keys and falls back to default explicit submitter', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-invalid-evm-target-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          notAnAddress: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x7777777777777777777777777777777777777777',
            version: '1.0',
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('ignores empty EVM override keys and falls back to default explicit submitter', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-empty-evm-target-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          '   ': {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x7777777777777777777777777777777777777777',
            version: '1.0',
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to default explicit submitter for malformed transaction target', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-malformed-target-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
        submitterOverrides: {
          '0x1111111111111111111111111111111111111111': {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x6666666666666666666666666666666666666666',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: 'not-an-evm-address' } as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('uses explicit submitter when overrides are absent even if tx target is malformed', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-explicit-no-overrides-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: 'not-an-evm-address' } as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('matches selector-specific override with mixed-case selector and target address', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-case-${Date.now()}.yaml`;
    const overrideTarget = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [`${overrideTarget}@0xDeAdBeEf`]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x6666666666666666666666666666666666666666',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const txWithSelector = {
      ...TX,
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      data: '0xdeadbeef0000',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithSelector as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('falls back to jsonRpc when inference fails', async () => {
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('caches provider lookup failures across inferred transactions', async () => {
    let providerCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getProvider: () => {
          providerCalls += 1;
          throw new Error('provider unavailable');
        },
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any, TX as any],
      context,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(providerCalls).to.equal(1);
  });

  it('reuses provider lookup across owner, safe, and timelock probes', async () => {
    const unknownOwner = '0x5555555555555555555555555555555555555555';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => unknownOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    let providerCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => {
          providerCalls += 1;
          return {};
        },
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(1);
      expect(safeStub.callCount).to.equal(1);
      expect(timelockStub.callCount).to.equal(1);
      expect(providerCalls).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when inference throws on malformed transaction target', async () => {
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: 'not-an-evm-address' } as any],
      context,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to jsonRpc when destination signer lookup fails during owner inference', async () => {
    const safeOwner = '0x4444444444444444444444444444444444444444';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => safeOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));

    let signerAddressCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => {
          signerAddressCalls += 1;
          throw new Error('missing signer');
        },
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownableStub.callCount).to.equal(1);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
      expect(signerAddressCalls).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('uses transaction from fallback when transaction target is malformed', async () => {
    const fromSafe = '0x4444444444444444444444444444444444444444';
    const ownableStub = sinon.stub(Ownable__factory, 'connect');
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== fromSafe.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          {
            ...TX,
            to: 'not-an-evm-address',
            from: ` ${fromSafe} `,
          } as any,
        ],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(ownableStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('uses transaction from fallback when owner read returns malformed address', async () => {
    const fromSafe = '0x4444444444444444444444444444444444444444';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => 'not-an-evm-address',
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== fromSafe.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          {
            ...TX,
            to: '0x1111111111111111111111111111111111111111',
            from: fromSafe,
          } as any,
        ],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(ownableStub.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('caches failed owner reads while still using from-based fallback inference', async () => {
    const fromSafe = '0x4444444444444444444444444444444444444444';
    let ownerReads = 0;
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => {
        ownerReads += 1;
        throw new Error('owner read failed');
      },
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== fromSafe.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          {
            ...TX,
            from: fromSafe,
          } as any,
          {
            ...TX,
            from: fromSafe,
            data: '0xdeadbeef',
          } as any,
        ],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(ownerReads).to.equal(1);
      expect(safeStub.callCount).to.equal(1);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('normalizes owner address from ownable read before submitter inference', async () => {
    const safeOwner = '0x4444444444444444444444444444444444444444';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => '  0X4444444444444444444444444444444444444444  ',
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeOwner.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(ownableStub.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('caches owner reads for repeated transaction targets', async () => {
    const safeOwner = '0x4444444444444444444444444444444444444444';
    let ownerReads = 0;
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => {
        ownerReads += 1;
        return safeOwner;
      },
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeOwner.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, { ...TX, data: '0xdeadbeef' } as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(ownerReads).to.equal(1);
      expect(safeStub.callCount).to.equal(1);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('caches failed owner reads for repeated transaction targets', async () => {
    let ownerReads = 0;
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => {
        ownerReads += 1;
        throw new Error('owner read failed');
      },
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, { ...TX, data: '0xdeadbeef' } as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(ownerReads).to.equal(1);
      expect(safeStub.callCount).to.equal(1);
      expect(timelockStub.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when owner is unknown submitter type', async () => {
    const unknownOwner = '0x5555555555555555555555555555555555555555';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => unknownOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => {
          throw new Error('not timelock');
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when ownable read fails and transaction from is malformed', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('not ownable'));

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, from: 'not-an-evm-address' } as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
    } finally {
      ownableStub.restore();
    }
  });

  it('ignores explicit strategy on extended chains', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-extended-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x3333333333333333333333333333333333333333',
          version: '1.0',
        },
      },
    });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context,
      strategyUrl: strategyPath,
      isExtendedChain: true,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('ignores explicit submitterOverrides on extended chains', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-extended-overrides-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          '0x1111111111111111111111111111111111111111': {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x3333333333333333333333333333333333333333',
            version: '1.0',
          },
        },
      },
    });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context,
      strategyUrl: strategyPath,
      isExtendedChain: true,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('uses default jsonRpc for non-ethereum chains', async () => {
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.CosmosNative,
      },
    } as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('uses non-ethereum default when strategy file has no config for chain', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-non-evm-missing-chain-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      anvil3: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: 'anvil3',
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
      },
    });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.CosmosNative,
      },
    } as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('routes non-ethereum explicit overrides by exact target key', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-overrides-${Date.now()}.yaml`;
    const overrideTarget = 'cosmos1overrideaddress000000000000000000000000';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txDefault = {
      ...TX,
      to: 'cosmos1defaultaddress0000000000000000000000000',
    };
    const txOverride = {
      ...TX,
      to: overrideTarget,
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txDefault as any, txOverride as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.CosmosNative,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(2);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[1].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('matches non-ethereum explicit override keys with whitespace padding', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-overrides-whitespace-${Date.now()}.yaml`;
    const overrideTarget = 'cosmos1overrideaddress000000000000000000000000';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [`  ${overrideTarget}  `]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txOverride = {
      ...TX,
      to: overrideTarget,
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txOverride as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.CosmosNative,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('matches non-ethereum explicit override when transaction target has whitespace', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-overrides-target-whitespace-${Date.now()}.yaml`;
    const overrideTarget = 'cosmos1overrideaddress000000000000000000000000';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txOverride = {
      ...TX,
      to: `  ${overrideTarget}  `,
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txOverride as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.CosmosNative,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('ignores empty non-ethereum override keys and falls back to default explicit submitter', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-empty-key-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          '   ': {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txDefault = {
      ...TX,
      to: 'cosmos1defaultaddress0000000000000000000000000',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txDefault as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.CosmosNative,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('keeps first non-ethereum override when trimmed keys collide', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-collision-${Date.now()}.yaml`;
    const overrideTarget = 'cosmos1overrideaddress000000000000000000000000';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [`  ${overrideTarget}  `]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
          [overrideTarget]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x9999999999999999999999999999999999999999',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const txOverride = {
      ...TX,
      to: overrideTarget,
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txOverride as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.CosmosNative,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('splits non-ethereum explicit overrides when matches are non-contiguous', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-order-${Date.now()}.yaml`;
    const overrideTarget = 'cosmos1overrideaddress000000000000000000000000';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txDefaultFirst = {
      ...TX,
      to: 'cosmos1defaultfirst0000000000000000000000000',
    };
    const txOverride = {
      ...TX,
      to: overrideTarget,
    };
    const txDefaultLast = {
      ...TX,
      to: 'cosmos1defaultlast00000000000000000000000000',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [
        txDefaultFirst as any,
        txOverride as any,
        txDefaultLast as any,
      ],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.CosmosNative,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(3);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[1].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(batches[2].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[0].transactions).to.deep.equal([txDefaultFirst as any]);
    expect(batches[1].transactions).to.deep.equal([txOverride as any]);
    expect(batches[2].transactions).to.deep.equal([txDefaultLast as any]);
  });

  it('routes same-chain transactions to different inferred submitters', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const txSignerOwned = {
      ...TX,
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const txSafeOwned = {
      ...TX,
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () =>
            targetAddress.toLowerCase() === txSignerOwned.to.toLowerCase()
              ? SIGNER
              : safeOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeOwner.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [txSignerOwned as any, txSafeOwned as any],
        context,
      });

      expect(batches).to.have.length(2);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(batches[1].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(batches[0].transactions).to.deep.equal([txSignerOwned as any]);
      expect(batches[1].transactions).to.deep.equal([txSafeOwned as any]);
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('preserves transaction order by splitting non-contiguous inferred submitter matches', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const txSignerFirst = {
      ...TX,
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const txSafeOwned = {
      ...TX,
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    const txSignerLast = {
      ...TX,
      to: '0xcccccccccccccccccccccccccccccccccccccccc',
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () =>
            targetAddress.toLowerCase() === txSafeOwned.to.toLowerCase()
              ? safeOwner
              : SIGNER,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeOwner.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          txSignerFirst as any,
          txSafeOwned as any,
          txSignerLast as any,
        ],
        context,
      });

      expect(batches).to.have.length(3);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(batches[1].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(batches[2].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(batches[0].transactions).to.deep.equal([txSignerFirst as any]);
      expect(batches[1].transactions).to.deep.equal([txSafeOwned as any]);
      expect(batches[2].transactions).to.deep.equal([txSignerLast as any]);
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('coalesces adjacent inferred submitter matches into single batches', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const txSignerFirst = {
      ...TX,
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const txSignerSecond = {
      ...TX,
      to: '0xabababababababababababababababababababab',
    };
    const txSafeFirst = {
      ...TX,
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    const txSafeSecond = {
      ...TX,
      to: '0xbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc',
    };
    const txSignerLast = {
      ...TX,
      to: '0xcccccccccccccccccccccccccccccccccccccccc',
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () =>
            targetAddress.toLowerCase() === txSafeFirst.to.toLowerCase() ||
            targetAddress.toLowerCase() === txSafeSecond.to.toLowerCase()
              ? safeOwner
              : SIGNER,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeOwner.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          txSignerFirst as any,
          txSignerSecond as any,
          txSafeFirst as any,
          txSafeSecond as any,
          txSignerLast as any,
        ],
        context,
      });

      expect(batches).to.have.length(3);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(batches[1].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(batches[2].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(batches[0].transactions).to.deep.equal([
        txSignerFirst as any,
        txSignerSecond as any,
      ]);
      expect(batches[1].transactions).to.deep.equal([
        txSafeFirst as any,
        txSafeSecond as any,
      ]);
      expect(batches[2].transactions).to.deep.equal([txSignerLast as any]);
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('uses transaction from as fallback inference source when ownable read fails', async () => {
    const fromSafe = '0x4444444444444444444444444444444444444444';
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('not ownable'));
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== fromSafe.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, from: fromSafe } as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('normalizes uppercase 0X transaction from before fallback inference', async () => {
    const fromSafe = '0x4444444444444444444444444444444444444444';
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('not ownable'));
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== fromSafe.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, from: '  0X4444444444444444444444444444444444444444  ' } as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('normalizes uppercase 0X transaction target before inference owner lookup', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (_targetAddressInput: string) =>
        ({
          owner: async () => safeOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeOwner.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: '  0Xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  ' } as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('falls back to jsonRpc when inferred ICA owner origin signer is unavailable', async () => {
    const inferredIcaOwner = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const destinationRouterAddress =
      '0x9999999999999999999999999999999999999999';
    const originRouterAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              inferredIcaOwner,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        tryGetSigner: (chainName: string) => (chainName === CHAIN ? {} : null),
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when origin signer lookup fails and tryGetSigner is unavailable', async () => {
    const inferredIcaOwner = '0xabababababababababababababababababababab';
    const destinationRouterAddress =
      '0xbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc';
    const originRouterAddress = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              inferredIcaOwner,
          } as any;
        }

        throw new Error('unexpected router');
      });

    let signerAddressCalls = 0;
    let providerCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          signerAddressCalls += 1;
          if (chainName === CHAIN) {
            return SIGNER;
          }
          throw new Error('origin signer unavailable');
        },
        getProvider: (chainName: string) => {
          providerCalls += 1;
          if (chainName === CHAIN) {
            return provider;
          }
          throw new Error('origin provider unavailable');
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(1);
      expect(signerAddressCalls).to.equal(2);
      expect(providerCalls).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches no-tryGetSigner origin signer lookup failures across direct ICA inferences', async () => {
    const inferredIcaOwnerA = '0xd6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6';
    const inferredIcaOwnerB = '0xe7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7';
    const destinationRouterAddress =
      '0xf8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8';
    const originRouterAddress = '0xf9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9';

    const ownerByTarget: Record<string, string> = {
      '0x1111111111111111111111111111111111111111': inferredIcaOwnerA,
      '0x2222222222222222222222222222222222222222': inferredIcaOwnerB,
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () => ownerByTarget[targetAddress.toLowerCase()],
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              inferredIcaOwnerA,
          } as any;
        }

        throw new Error('unexpected router');
      });

    let signerAddressCalls = 0;
    let providerCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          signerAddressCalls += 1;
          if (chainName === CHAIN) {
            return SIGNER;
          }
          throw new Error('origin signer unavailable');
        },
        getProvider: (chainName: string) => {
          providerCalls += 1;
          if (chainName === CHAIN) {
            return provider;
          }
          throw new Error('origin provider unavailable');
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x2222222222222222222222222222222222222222' } as any,
        ],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].transactions).to.have.length(2);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(2);
      expect(signerAddressCalls).to.equal(2);
      expect(providerCalls).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when event-derived ICA origin signer is unavailable', async () => {
    const inferredIcaOwner = '0x1212121212121212121212121212121212121212';
    const destinationRouterAddress =
      '0x3434343434343434343434343434343434343434';
    const originRouterAddress = '0x5656565656565656565656565656565656565656';
    const originRouterBytes32 =
      '0x0000000000000000000000005656565656565656565656565656565656565656';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([{ topics: [], data: '0x' }]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
            interface: {
              parseLog: (_log: unknown) => ({
                args: {
                  origin: 31347,
                  router: originRouterBytes32,
                  owner: SIGNER,
                  ism: ethersConstants.AddressZero,
                },
              }),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              inferredIcaOwner,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) return 'anvil3';
          throw new Error('unknown domain');
        },
        tryGetSigner: (chainName: string) => (chainName === CHAIN ? {} : null),
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches null when ICA event log parsing fails', async () => {
    const inferredIcaOwner = '0x7878787878787878787878787878787878787878';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([{ topics: [], data: '0x' }]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
            interface: {
              parseLog: () => {
                throw new Error('malformed ICA event');
              },
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches null when ICA event log has malformed bytes32 fields', async () => {
    const inferredIcaOwner = '0x7979797979797979797979797979797979797979';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([{ topics: [], data: '0x' }]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
            interface: {
              parseLog: () => ({
                args: {
                  origin: 31347,
                  router: '0x1234', // malformed bytes32
                  owner: `0x000000000000000000000000${SIGNER.slice(2)}`,
                  ism: ethersConstants.AddressZero,
                },
              }),
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches unknown origin domain lookups across ICA event-derived inferences', async () => {
    const inferredIcaOwnerA = '0x7676767676767676767676767676767676767676';
    const inferredIcaOwnerB = '0x8686868686868686868686868686868686868686';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originOwnerBytes32 =
      `0x000000000000000000000000${SIGNER.slice(2)}` as const;

    const ownerByTarget: Record<string, string> = {
      '0xabababababababababababababababababababab': inferredIcaOwnerA,
      '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd': inferredIcaOwnerB,
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () => ownerByTarget[targetAddress.toLowerCase()],
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([{ topics: [], data: '0x' }]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
            interface: {
              parseLog: () => ({
                args: {
                  origin: 999999,
                  router:
                    '0x0000000000000000000000009191919191919191919191919191919191919191',
                  owner: originOwnerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              }),
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    let chainNameCalls = 0;
    let providerCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => {
          providerCalls += 1;
          return provider;
        },
        getChainName: () => {
          chainNameCalls += 1;
          throw new Error('unknown domain');
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0xABABABABABABABABABABABABABABABABABABABAB' } as any,
          { ...TX, to: '0xCDCDCDCDCDCDCDCDCDCDCDCDCDCDCDCDCDCDCDCD' } as any,
        ],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(2);
      expect(chainNameCalls).to.equal(1);
      expect(providerCalls).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('uses latest ICA event log by on-chain position when provider logs are unsorted', async () => {
    const inferredIcaOwner = '0x8787878787878787878787878787878787878787';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originRouterAddress = '0x9191919191919191919191919191919191919191';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const newerLog = {
      topics: ['0xnewer'],
      data: '0x',
      blockNumber: 102,
      transactionIndex: 0,
      logIndex: 1,
    };
    const olderLog = {
      topics: ['0xolder'],
      data: '0x',
      blockNumber: 101,
      transactionIndex: 0,
      logIndex: 1,
    };
    const provider = {
      getLogs: sinon.stub().resolves([newerLog, olderLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === newerLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('uses transaction/log index ordering when ICA event logs share block number', async () => {
    const inferredIcaOwner = '0x8888888888888888888888888888888888888888';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originRouterAddress = '0x9191919191919191919191919191919191919191';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const newerLog = {
      topics: ['0xnewer'],
      data: '0x',
      blockNumber: 200,
      transactionIndex: 9,
      logIndex: 1,
    };
    const olderLog = {
      topics: ['0xolder'],
      data: '0x',
      blockNumber: 200,
      transactionIndex: 8,
      logIndex: 50,
    };
    const provider = {
      // intentionally unsorted newest-first to ensure array tail is not trusted
      getLogs: sinon.stub().resolves([newerLog, olderLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === newerLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('uses log index ordering when ICA event logs share block and transaction index', async () => {
    const inferredIcaOwner = '0x8989898989898989898989898989898989898989';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originRouterAddress = '0x9191919191919191919191919191919191919191';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const newerLog = {
      topics: ['0xnewer'],
      data: '0x',
      blockNumber: 201,
      transactionIndex: 4,
      logIndex: 20,
    };
    const olderLog = {
      topics: ['0xolder'],
      data: '0x',
      blockNumber: 201,
      transactionIndex: 4,
      logIndex: 19,
    };
    const provider = {
      // intentionally unsorted newest-first so resolver cannot trust array order
      getLogs: sinon.stub().resolves([newerLog, olderLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === newerLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('handles ICA event logs with missing positional fields deterministically', async () => {
    const inferredIcaOwner = '0x8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originRouterAddress = '0x9191919191919191919191919191919191919191';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const logWithMissingIndices = {
      topics: ['0xmissing-indices'],
      data: '0x',
      blockNumber: undefined,
      transactionIndex: undefined,
      logIndex: undefined,
    };
    const fullyIndexedLog = {
      topics: ['0xindexed'],
      data: '0x',
      blockNumber: 202,
      transactionIndex: 1,
      logIndex: 1,
    };
    const provider = {
      // unsorted with partial data first
      getLogs: sinon.stub().resolves([logWithMissingIndices, fullyIndexedLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === fullyIndexedLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('handles bigint ICA event positional fields deterministically', async () => {
    const inferredIcaOwner = '0x8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originRouterAddress = '0x9191919191919191919191919191919191919191';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const olderLog = {
      topics: ['0xolder'],
      data: '0x',
      blockNumber: 500n,
      transactionIndex: 1n,
      logIndex: 1n,
    };
    const newerLog = {
      topics: ['0xnewer'],
      data: '0x',
      blockNumber: 501n,
      transactionIndex: 0n,
      logIndex: 0n,
    };
    const provider = {
      getLogs: sinon.stub().resolves([olderLog, newerLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === newerLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('handles very large bigint ICA event positions without precision loss', async () => {
    const inferredIcaOwner = '0x8a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originRouterAddress = '0x9191919191919191919191919191919191919191';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const olderLog = {
      topics: ['0xolder'],
      data: '0x',
      blockNumber: 9007199254740993n,
      transactionIndex: 0n,
      logIndex: 0n,
    };
    const newerLog = {
      topics: ['0xnewer'],
      data: '0x',
      blockNumber: 9007199254740994n,
      transactionIndex: 0n,
      logIndex: 0n,
    };
    const provider = {
      // intentionally unsorted newest-first
      getLogs: sinon.stub().resolves([newerLog, olderLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === newerLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('handles BigNumber-like ICA event positional fields deterministically', async () => {
    const inferredIcaOwner = '0x8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originRouterAddress = '0x9191919191919191919191919191919191919191';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;
    const asBigNumberLike = (value: string) =>
      ({
        toString: () => value,
      }) as any;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const olderLog = {
      topics: ['0xolder'],
      data: '0x',
      blockNumber: asBigNumberLike('700'),
      transactionIndex: asBigNumberLike('2'),
      logIndex: asBigNumberLike('4'),
    };
    const newerLog = {
      topics: ['0xnewer'],
      data: '0x',
      blockNumber: asBigNumberLike('701'),
      transactionIndex: asBigNumberLike('0'),
      logIndex: asBigNumberLike('0'),
    };
    const provider = {
      // intentionally unsorted newest-last/first should not matter
      getLogs: sinon.stub().resolves([olderLog, newerLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === newerLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('handles string-encoded ICA event positional fields deterministically', async () => {
    const inferredIcaOwner = '0x8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originRouterAddress = '0x9191919191919191919191919191919191919191';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const olderLog = {
      topics: ['0xolder'],
      data: '0x',
      blockNumber: '900',
      transactionIndex: '2',
      logIndex: '3',
    };
    const newerLog = {
      topics: ['0xnewer'],
      data: '0x',
      blockNumber: ' 901 ',
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      // intentionally unsorted newest-first
      getLogs: sinon.stub().resolves([newerLog, olderLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === newerLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('handles hex-string ICA event positional fields deterministically', async () => {
    const inferredIcaOwner = '0x8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originRouterAddress = '0x9191919191919191919191919191919191919191';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const olderLog = {
      topics: ['0xolder'],
      data: '0x',
      blockNumber: '0x400',
      transactionIndex: '0x1',
      logIndex: '0x2',
    };
    const newerLog = {
      topics: ['0xnewer'],
      data: '0x',
      blockNumber: '0x401',
      transactionIndex: '0x0',
      logIndex: '0x0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([newerLog, olderLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === newerLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('handles uppercase hex-string ICA event positional fields deterministically', async () => {
    const inferredIcaOwner = '0x9090909090909090909090909090909090909090';
    const destinationRouterAddress =
      '0x9191919191919191919191919191919191919191';
    const originRouterAddress = '0x9292929292929292929292929292929292929292';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const olderLog = {
      topics: ['0xolder'],
      data: '0x',
      blockNumber: '0X500',
      transactionIndex: '0X1',
      logIndex: '0X2',
    };
    const newerLog = {
      topics: ['0xnewer'],
      data: '0x',
      blockNumber: '0X501',
      transactionIndex: '0X0',
      logIndex: '0X0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([newerLog, olderLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === newerLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('handles whitespace-padded hex ICA event positional fields deterministically', async () => {
    const inferredIcaOwner = '0x9191919191919191919191919191919191919191';
    const destinationRouterAddress =
      '0x9292929292929292929292929292929292929292';
    const originRouterAddress = '0x9393939393939393939393939393939393939393';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const olderLog = {
      topics: ['0xolder'],
      data: '0x',
      blockNumber: ' 0x700 ',
      transactionIndex: ' 0x1 ',
      logIndex: ' 0x2 ',
    };
    const newerLog = {
      topics: ['0xnewer'],
      data: '0x',
      blockNumber: ' 0X701 ',
      transactionIndex: ' 0X0 ',
      logIndex: ' 0X0 ',
    };
    const provider = {
      getLogs: sinon.stub().resolves([newerLog, olderLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === newerLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('handles very large decimal-string ICA event positions without precision loss', async () => {
    const inferredIcaOwner = '0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
    const destinationRouterAddress =
      '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
    const originRouterAddress = '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const olderLog = {
      topics: ['0xolder'],
      data: '0x',
      blockNumber: '900719925474099312345678',
      transactionIndex: '0',
      logIndex: '0',
    };
    const newerLog = {
      topics: ['0xnewer'],
      data: '0x',
      blockNumber: '900719925474099312345679',
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      // intentionally unsorted newest-first
      getLogs: sinon.stub().resolves([newerLog, olderLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === newerLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores malformed hex-string ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0xa3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3';
    const destinationRouterAddress =
      '0xa4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4';
    const originRouterAddress = '0xa5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: '1001',
      transactionIndex: '0',
      logIndex: '0',
    };
    const malformedHigherLog = {
      topics: ['0xmalformed-high'],
      data: '0x',
      blockNumber: '0x3ZZ',
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      // malformed hex should be treated as missing position and not outrank valid log
      getLogs: sinon.stub().resolves([validLog, malformedHigherLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores empty-hex-prefix ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0xa6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6';
    const destinationRouterAddress =
      '0xa7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7';
    const originRouterAddress = '0xa8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: '1002',
      transactionIndex: '0',
      logIndex: '0',
    };
    const malformedHexPrefixLog = {
      topics: ['0xmalformed-prefix'],
      data: '0x',
      blockNumber: '0x',
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      // empty hex prefix must be ignored instead of treated as index zero
      getLogs: sinon.stub().resolves([validLog, malformedHexPrefixLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores non-integer string ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0x8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originRouterAddress = '0x9191919191919191919191919191919191919191';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: '1000',
      transactionIndex: '0',
      logIndex: '0',
    };
    const malformedHighLog = {
      topics: ['0xmalformed-high'],
      data: '0x',
      blockNumber: '9999.9',
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      // malformed log appears later in raw response and should not outrank valid one
      getLogs: sinon.stub().resolves([validLog, malformedHighLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores plus-prefixed decimal-string ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0xa9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9';
    const destinationRouterAddress =
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const originRouterAddress = '0xabababababababababababababababababababab';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: '1003',
      transactionIndex: '0',
      logIndex: '0',
    };
    const malformedPlusLog = {
      topics: ['0xmalformed-plus'],
      data: '0x',
      blockNumber: '+9999',
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      // plus-prefixed decimal should be rejected by normalization
      getLogs: sinon.stub().resolves([validLog, malformedPlusLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores overlong hex-string ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0xacacacacacacacacacacacacacacacacacacacac';
    const destinationRouterAddress =
      '0xadadadadadadadadadadadadadadadadadadadad';
    const originRouterAddress = '0xaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: '1004',
      transactionIndex: '0',
      logIndex: '0',
    };
    const malformedOverlongLog = {
      topics: ['0xmalformed-overlong'],
      data: '0x',
      blockNumber: `0x${'f'.repeat(300)}`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      // overlong numeric strings should be rejected to avoid expensive bigint parsing
      getLogs: sinon.stub().resolves([validLog, malformedOverlongLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('accepts overlong zero-padded hex ICA event positions deterministically', async () => {
    const inferredIcaOwner = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const destinationRouterAddress =
      '0xbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc';
    const originRouterAddress = '0xbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbd';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const higherLog = {
      topics: ['0xhigher'],
      data: '0x',
      blockNumber: `0x${'0'.repeat(300)}2`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const lowerLog = {
      topics: ['0xlower'],
      data: '0x',
      blockNumber: `0x${'0'.repeat(300)}1`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([lowerLog, higherLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === higherLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores excessively long raw hex ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
    const destinationRouterAddress =
      '0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
    const originRouterAddress = '0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: '1007',
      transactionIndex: '0',
      logIndex: '0',
    };
    const malformedRawLengthLog = {
      topics: ['0xmalformed-raw-length'],
      data: '0x',
      blockNumber: `0x${'0'.repeat(5000)}2`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([validLog, malformedRawLengthLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores excessively long raw whitespace-padded ICA event positions during ordering', async () => {
    const inferredIcaOwner = '0xc7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7';
    const destinationRouterAddress =
      '0xc8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8';
    const originRouterAddress = '0xc9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: '1009',
      transactionIndex: '0',
      logIndex: '0',
    };
    const malformedRawWhitespaceLog = {
      topics: ['0xmalformed-raw-whitespace'],
      data: '0x',
      blockNumber: `${' '.repeat(5000)}9999`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([validLog, malformedRawWhitespaceLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('accepts raw-length-boundary whitespace-padded ICA event positions deterministically', async () => {
    const inferredIcaOwner = '0xcacacacacacacacacacacacacacacacacacacaca';
    const destinationRouterAddress =
      '0xcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcb';
    const originRouterAddress = '0xcccccccccccccccccccccccccccccccccccccccc';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const higherLog = {
      topics: ['0xhigher'],
      data: '0x',
      blockNumber: `${' '.repeat(4095)}2`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const lowerLog = {
      topics: ['0xlower'],
      data: '0x',
      blockNumber: `${' '.repeat(4095)}1`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([lowerLog, higherLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === higherLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('accepts max-length hex-string ICA event positions deterministically', async () => {
    const inferredIcaOwner = '0xb5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5';
    const destinationRouterAddress =
      '0xb6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6';
    const originRouterAddress = '0xb7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const higherLog = {
      topics: ['0xhigher'],
      data: '0x',
      blockNumber: `0x${'f'.repeat(254)}`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const lowerLog = {
      topics: ['0xlower'],
      data: '0x',
      blockNumber: `0x${'f'.repeat(253)}`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([lowerLog, higherLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === higherLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores overlong decimal-string ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0xafafafafafafafafafafafafafafafafafafafaf';
    const destinationRouterAddress =
      '0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
    const originRouterAddress = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: '1005',
      transactionIndex: '0',
      logIndex: '0',
    };
    const malformedOverlongLog = {
      topics: ['0xmalformed-overlong-decimal'],
      data: '0x',
      blockNumber: '9'.repeat(300),
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([validLog, malformedOverlongLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('accepts max-length decimal-string ICA event positions deterministically', async () => {
    const inferredIcaOwner = '0xb8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8';
    const destinationRouterAddress =
      '0xb9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9';
    const originRouterAddress = '0xbabababababababababababababababababababa';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const higherLog = {
      topics: ['0xhigher'],
      data: '0x',
      blockNumber: '1'.repeat(256),
      transactionIndex: '0',
      logIndex: '0',
    };
    const lowerLog = {
      topics: ['0xlower'],
      data: '0x',
      blockNumber: '9'.repeat(255),
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([lowerLog, higherLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === higherLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('accepts overlong zero-padded decimal ICA event positions deterministically', async () => {
    const inferredIcaOwner = '0xbebebebebebebebebebebebebebebebebebebebe';
    const destinationRouterAddress =
      '0xbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbf';
    const originRouterAddress = '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const higherLog = {
      topics: ['0xhigher'],
      data: '0x',
      blockNumber: `${'0'.repeat(300)}2`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const lowerLog = {
      topics: ['0xlower'],
      data: '0x',
      blockNumber: `${'0'.repeat(300)}1`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([lowerLog, higherLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === higherLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores overlong toString ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
    const destinationRouterAddress =
      '0xb3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3';
    const originRouterAddress = '0xb4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: '1006',
      transactionIndex: '0',
      logIndex: '0',
    };
    const malformedToStringLog = {
      topics: ['0xmalformed-tostring-overlong'],
      data: '0x',
      blockNumber: {
        toString: () => `0x${'f'.repeat(300)}`,
      },
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([validLog, malformedToStringLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores excessively long raw toString ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0xc4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4';
    const destinationRouterAddress =
      '0xc5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5';
    const originRouterAddress = '0xc6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: '1008',
      transactionIndex: '0',
      logIndex: '0',
    };
    const malformedRawToStringLog = {
      topics: ['0xmalformed-raw-tostring'],
      data: '0x',
      blockNumber: {
        toString: () => `0x${'0'.repeat(5000)}2`,
      },
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([validLog, malformedRawToStringLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores non-string toString ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0x9090909090909090909090909090909090909090';
    const destinationRouterAddress =
      '0x9191919191919191919191919191919191919191';
    const originRouterAddress = '0x9292929292929292929292929292929292929292';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: '1100',
      transactionIndex: '0',
      logIndex: '0',
    };
    const malformedLog = {
      topics: ['0xmalformed'],
      data: '0x',
      blockNumber: {
        toString: () => ({}) as any,
      },
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([validLog, malformedLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores throwing toString ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0x9494949494949494949494949494949494949494';
    const destinationRouterAddress =
      '0x9595959595959595959595959595959595959595';
    const originRouterAddress = '0x9696969696969696969696969696969696969696';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: '1500',
      transactionIndex: '0',
      logIndex: '0',
    };
    const malformedLog = {
      topics: ['0xmalformed'],
      data: '0x',
      blockNumber: {
        toString: () => {
          throw new Error('toString failed');
        },
      },
      transactionIndex: '0',
      logIndex: '0',
    };
    const provider = {
      getLogs: sinon.stub().resolves([validLog, malformedLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores unsafe-number ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0x9393939393939393939393939393939393939393';
    const destinationRouterAddress =
      '0x9494949494949494949494949494949494949494';
    const originRouterAddress = '0x9595959595959595959595959595959595959595';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 1300,
      transactionIndex: 0,
      logIndex: 0,
    };
    const malformedLog = {
      topics: ['0xmalformed'],
      data: '0x',
      blockNumber: 1e20,
      transactionIndex: 0,
      logIndex: 0,
    };
    const provider = {
      getLogs: sinon.stub().resolves([validLog, malformedLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores fractional-number ICA event positions during log ordering', async () => {
    const inferredIcaOwner = '0x9797979797979797979797979797979797979797';
    const destinationRouterAddress =
      '0x9898989898989898989898989898989898989898';
    const originRouterAddress = '0x9999999999999999999999999999999999999999';
    const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
    const originRouterBytes32 = `0x000000000000000000000000${originRouterAddress.slice(
      2,
    )}` as const;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const validLog = {
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 1700,
      transactionIndex: 0,
      logIndex: 0,
    };
    const malformedLog = {
      topics: ['0xmalformed'],
      data: '0x',
      blockNumber: 1700.5,
      transactionIndex: 0,
      logIndex: 0,
    };
    const provider = {
      getLogs: sinon.stub().resolves([validLog, malformedLog]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== destinationRouterAddress.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              if (log === validLog) {
                return {
                  args: {
                    origin: 31347,
                    router: originRouterBytes32,
                    owner: signerBytes32,
                    ism: ethersConstants.AddressZero,
                  },
                };
              }
              return {
                args: {
                  origin: 999999,
                  router: originRouterBytes32,
                  owner: signerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              };
            },
          },
        } as any;
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return 'anvil3';
          }
          throw new Error(`unknown domain ${domainId}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('uses jsonRpc internal submitter when ICA event-derived origin signer lookup fails', async () => {
    const inferredIcaOwner = '0x6868686868686868686868686868686868686868';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originOwner = '0x8181818181818181818181818181818181818181';
    const originOwnerBytes32 =
      `0x000000000000000000000000${originOwner.slice(2)}` as const;
    const originRouterBytes32 =
      '0x0000000000000000000000009191919191919191919191919191919191919191';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([{ topics: [], data: '0x' }]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
            interface: {
              parseLog: () => ({
                args: {
                  origin: 31347,
                  router: originRouterBytes32,
                  owner: originOwnerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              }),
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    const signerAddressCallsByChain: Record<string, number> = {};
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          signerAddressCallsByChain[chainName] =
            (signerAddressCallsByChain[chainName] ?? 0) + 1;
          if (chainName === CHAIN) {
            return SIGNER;
          }
          throw new Error('origin signer unavailable');
        },
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) return 'anvil3';
          throw new Error('unknown domain');
        },
        tryGetSigner: (chainName: string) => (chainName === 'anvil3' ? {} : null),
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).internalSubmitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(provider.getLogs.callCount).to.equal(1);
      // tx1: destination owner inference + origin signer lookup for internal submitter
      // tx2: both signer resolutions are cache hits
      expect(signerAddressCallsByChain[CHAIN]).to.equal(1);
      expect(signerAddressCallsByChain.anvil3).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when ICA event-derived origin signer lookup fails without tryGetSigner', async () => {
    const inferredIcaOwner = '0x9898989898989898989898989898989898989898';
    const destinationRouterAddress =
      '0x9191919191919191919191919191919191919191';
    const originOwner = '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
    const originOwnerBytes32 =
      `0x000000000000000000000000${originOwner.slice(2)}` as const;
    const originRouterBytes32 =
      '0x0000000000000000000000009292929292929292929292929292929292929292';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([{ topics: [], data: '0x' }]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
            interface: {
              parseLog: () => ({
                args: {
                  origin: 31347,
                  router: originRouterBytes32,
                  owner: originOwnerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              }),
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    const signerAddressCallsByChain: Record<string, number> = {};
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          signerAddressCallsByChain[chainName] =
            (signerAddressCallsByChain[chainName] ?? 0) + 1;
          if (chainName === CHAIN) {
            return SIGNER;
          }
          throw new Error('origin signer unavailable');
        },
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) return 'anvil3';
          throw new Error('unknown domain');
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(1);
      expect(signerAddressCallsByChain[CHAIN]).to.equal(1);
      expect(signerAddressCallsByChain.anvil3).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches no-tryGetSigner origin signer lookup failures across event-derived ICA inferences', async () => {
    const inferredIcaOwnerA = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
    const inferredIcaOwnerB = '0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
    const destinationRouterAddress =
      '0xd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3';
    const originOwner = '0xe4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4';
    const originOwnerBytes32 =
      `0x000000000000000000000000${originOwner.slice(2)}` as const;
    const originRouterBytes32 =
      '0x000000000000000000000000f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5';

    const ownerByTarget: Record<string, string> = {
      '0x1111111111111111111111111111111111111111': inferredIcaOwnerA,
      '0x2222222222222222222222222222222222222222': inferredIcaOwnerB,
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () => ownerByTarget[targetAddress.toLowerCase()],
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([{ topics: [], data: '0x' }]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
            interface: {
              parseLog: () => ({
                args: {
                  origin: 31347,
                  router: originRouterBytes32,
                  owner: originOwnerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              }),
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    const signerAddressCallsByChain: Record<string, number> = {};
    let chainNameCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          signerAddressCallsByChain[chainName] =
            (signerAddressCallsByChain[chainName] ?? 0) + 1;
          if (chainName === CHAIN) {
            return SIGNER;
          }
          throw new Error('origin signer unavailable');
        },
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          chainNameCalls += 1;
          if (domainId === 31347) return 'anvil3';
          throw new Error('unknown domain');
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x2222222222222222222222222222222222222222' } as any,
        ],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].transactions).to.have.length(2);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(2);
      expect(chainNameCalls).to.equal(1);
      expect(signerAddressCallsByChain[CHAIN]).to.equal(1);
      expect(signerAddressCallsByChain.anvil3).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores unknown registry chains while deriving direct ICA owner fallback', async () => {
    const inferredIcaOwner = '0x1212121212121212121212121212121212121212';
    const destinationRouterAddress =
      '0x3434343434343434343434343434343434343434';
    const originRouterAddress = '0x5656565656565656565656565656565656565656';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              inferredIcaOwner,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: (chainName: string) => {
          if (chainName === 'unknownChain') {
            throw new Error('unknown chain metadata');
          }
          return ProtocolType.Ethereum;
        },
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        tryGetSigner: (chainName: string) => {
          if (chainName === 'anvil3') return {};
          return null;
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          unknownChain: {
            interchainAccountRouter:
              '0x7777777777777777777777777777777777777777',
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal('anvil3');
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches protocol checks while deriving direct ICA owner fallback', async () => {
    const inferredIcaOwnerA = '0x1111111111111111111111111111111111111111';
    const destinationRouterAddress =
      '0x3434343434343434343434343434343434343434';
    const originRouterAddress = '0x5656565656565656565656565656565656565656';

    const ownerByTarget: Record<string, string> = {
      '0xabababababababababababababababababababab': inferredIcaOwnerA,
      '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd': inferredIcaOwnerA,
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () => ownerByTarget[targetAddress.toLowerCase()],
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              inferredIcaOwnerA,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const protocolCalls: Record<string, number> = {};
    let registryReads = 0;
    const context = {
      multiProvider: {
        getProtocol: (chainName: string) => {
          protocolCalls[chainName] = (protocolCalls[chainName] ?? 0) + 1;
          if (chainName === 'unknownChain') {
            throw new Error('unknown chain metadata');
          }
          return ProtocolType.Ethereum;
        },
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        tryGetSigner: (chainName: string) => {
          if (chainName === 'anvil3') return {};
          return null;
        },
      },
      registry: {
        getAddresses: async () => {
          registryReads += 1;
          return {
            [CHAIN]: {
              interchainAccountRouter: destinationRouterAddress,
            },
            unknownChain: {
              interchainAccountRouter:
                '0x7777777777777777777777777777777777777777',
            },
            anvil3: {
              interchainAccountRouter: originRouterAddress,
            },
          };
        },
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0xABABABABABABABABABABABABABABABABABABABAB' } as any,
          { ...TX, to: '0xCDCDCDCDCDCDCDCDCDCDCDCDCDCDCDCDCDCDCDCD' } as any,
        ],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect(protocolCalls.unknownChain).to.equal(1);
      expect(protocolCalls.anvil3).to.equal(1);
      expect(registryReads).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when direct ICA registry lookup fails', async () => {
    const inferredIcaOwner = '0x9090909090909090909090909090909090909090';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    let registryReads = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => {
          registryReads += 1;
          throw new Error('registry unavailable');
        },
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
      expect(registryReads).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when direct ICA registry lookup returns empty value', async () => {
    const inferredIcaOwner = '0x9191919191919191919191919191919191919191';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    let registryReads = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => {
          registryReads += 1;
          return undefined as any;
        },
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
      expect(registryReads).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when direct ICA destination router address is invalid', async () => {
    const inferredIcaOwner = '0x9292929292929292929292929292929292929292';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    let registryReads = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => {
          registryReads += 1;
          return {
            [CHAIN]: {
              interchainAccountRouter: 'not-an-address',
            },
          };
        },
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
      expect(registryReads).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('reuses cached destination signer in ICA fallback path', async () => {
    const inferredIcaOwner = '0x9494949494949494949494949494949494949494';
    const destinationRouterAddress =
      '0x9595959595959595959595959595959595959595';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    let signerAddressCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => {
          signerAddressCalls += 1;
          if (signerAddressCalls === 1) {
            return SIGNER;
          }
          if (signerAddressCalls === 2) {
            throw new Error('destination signer unavailable');
          }
          return SIGNER;
        },
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      // first tx resolves signer once, ICA fallback reuses cached signer
      // second tx also reuses cache, so no additional signer lookups
      expect(signerAddressCalls).to.equal(1);
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches origin provider failure in ICA fallback path', async () => {
    const inferredIcaOwner = '0x9696969696969696969696969696969696969696';
    const destinationRouterAddress =
      '0x9797979797979797979797979797979797979797';
    const originRouterAddress = '0x9898989898989898989898989898989898989898';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const destinationProvider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    const providerCalls: Record<string, number> = {};
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: (chainName: string) => {
          providerCalls[chainName] = (providerCalls[chainName] ?? 0) + 1;
          if (chainName === CHAIN) {
            return destinationProvider;
          }
          if (chainName === 'anvil3') {
            throw new Error('origin provider unavailable');
          }
          throw new Error('unexpected provider chain');
        },
        tryGetSigner: () => ({}),
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(destinationProvider.getLogs.callCount).to.equal(1);
      expect(providerCalls[CHAIN]).to.equal(1);
      expect(providerCalls.anvil3).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches origin router derivation failures across direct ICA inferences', async () => {
    const inferredIcaOwner = '0xa8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8';
    const destinationRouterAddress =
      '0xb9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9';
    const originRouterAddress = '0xcacacacacacacacacacacacacacacacacacacaca';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => inferredIcaOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const destinationProvider = {
      getLogs: sinon.stub().resolves([]),
    };
    const originProvider = {};

    let originDerivationCalls = 0;
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () => {
              originDerivationCalls += 1;
              throw new Error('origin router derivation failed');
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    const providerCalls: Record<string, number> = {};
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: (chainName: string) => {
          providerCalls[chainName] = (providerCalls[chainName] ?? 0) + 1;
          if (chainName === CHAIN) return destinationProvider;
          if (chainName === 'anvil3') return originProvider;
          throw new Error(`unexpected provider lookup for ${chainName}`);
        },
        tryGetSigner: () => ({}),
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x2222222222222222222222222222222222222222' } as any,
        ],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].transactions).to.have.length(2);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(destinationProvider.getLogs.callCount).to.equal(1);
      expect(originDerivationCalls).to.equal(1);
      expect(providerCalls[CHAIN]).to.equal(1);
      expect(providerCalls.anvil3).to.equal(1);
      expect(ownableStub.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when ICA event log query fails', async () => {
    const inferredIcaOwner = '0x9292929292929292929292929292929292929292';
    const destinationRouterAddress =
      '0x9393939393939393939393939393939393939393';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().rejects(new Error('log query failed')),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when origin signer probe throws during ICA inference', async () => {
    const inferredIcaOwner = '0x7878787878787878787878787878787878787878';
    const destinationRouterAddress =
      '0x9090909090909090909090909090909090909090';
    const originRouterAddress = '0x9191919191919191919191919191919191919191';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              inferredIcaOwner,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        tryGetSigner: (chainName: string) => {
          if (chainName === CHAIN) return {};
          throw new Error(`No chain signer set for ${chainName}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches throwing origin signer probes across ICA inferences', async () => {
    const inferredIcaOwner = '0x7979797979797979797979797979797979797979';
    const destinationRouterAddress =
      '0x8080808080808080808080808080808080808080';
    const originRouterAddress = '0x8181818181818181818181818181818181818181';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              inferredIcaOwner,
          } as any;
        }

        throw new Error('unexpected router');
      });

    let originSignerProbeCalls = 0;
    let originSignerAddressLookups = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          if (chainName === CHAIN) return SIGNER;
          originSignerAddressLookups += 1;
          throw new Error(`unexpected signer lookup for ${chainName}`);
        },
        getProvider: () => provider,
        tryGetSigner: (chainName: string) => {
          if (chainName === CHAIN) return {};
          originSignerProbeCalls += 1;
          throw new Error(`No chain signer set for ${chainName}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(1);
      expect(originSignerProbeCalls).to.equal(1);
      expect(originSignerAddressLookups).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches unavailable origin signer probes across direct ICA inferences', async () => {
    const inferredIcaOwnerA = '0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a';
    const inferredIcaOwnerB = '0x9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b';
    const destinationRouterAddress =
      '0x9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c';
    const originRouterAddress = '0x9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d';

    const ownerByTarget: Record<string, string> = {
      '0x1111111111111111111111111111111111111111': inferredIcaOwnerA,
      '0x2222222222222222222222222222222222222222': inferredIcaOwnerB,
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () => ownerByTarget[targetAddress.toLowerCase()],
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              inferredIcaOwnerA,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const signerAddressCallsByChain: Record<string, number> = {};
    let originSignerProbeCalls = 0;
    let providerCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          signerAddressCallsByChain[chainName] =
            (signerAddressCallsByChain[chainName] ?? 0) + 1;
          if (chainName === CHAIN) {
            return SIGNER;
          }
          throw new Error(`unexpected signer lookup for ${chainName}`);
        },
        getProvider: (chainName: string) => {
          providerCalls += 1;
          if (chainName === CHAIN) {
            return provider;
          }
          throw new Error(`unexpected provider lookup for ${chainName}`);
        },
        tryGetSigner: (chainName: string) => {
          if (chainName === CHAIN) return {};
          originSignerProbeCalls += 1;
          return null;
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x2222222222222222222222222222222222222222' } as any,
        ],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].transactions).to.have.length(2);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(2);
      expect(originSignerProbeCalls).to.equal(1);
      expect(signerAddressCallsByChain[CHAIN]).to.equal(1);
      expect(signerAddressCallsByChain.anvil3 ?? 0).to.equal(0);
      expect(providerCalls).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('avoids origin signer address lookup when ICA origin signer is unavailable', async () => {
    const inferredIcaOwner = '0x4545454545454545454545454545454545454545';
    const destinationRouterAddress =
      '0x6767676767676767676767676767676767676767';
    const originRouterAddress = '0x8989898989898989898989898989898989898989';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              inferredIcaOwner,
          } as any;
        }

        throw new Error('unexpected router');
      });

    let originSignerAddressLookups = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          if (chainName === CHAIN) return SIGNER;
          originSignerAddressLookups += 1;
          throw new Error(`unexpected signer lookup for ${chainName}`);
        },
        getProvider: () => provider,
        tryGetSigner: (chainName: string) => (chainName === CHAIN ? {} : null),
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(originSignerAddressLookups).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches origin signer availability across event-derived ICA inferences', async () => {
    const inferredIcaOwnerA = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
    const inferredIcaOwnerB = '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
    const destinationRouterAddress =
      '0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
    const originRouterBytes32 =
      '0x000000000000000000000000d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';

    const ownerByTarget: Record<string, string> = {
      '0x1111111111111111111111111111111111111111': inferredIcaOwnerA,
      '0x2222222222222222222222222222222222222222': inferredIcaOwnerB,
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () => ownerByTarget[targetAddress.toLowerCase()],
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([{ topics: [], data: '0x' }]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
            interface: {
              parseLog: (_log: unknown) => ({
                args: {
                  origin: 31347,
                  router: originRouterBytes32,
                  owner: SIGNER,
                  ism: ethersConstants.AddressZero,
                },
              }),
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    let tryGetSignerCalls = 0;
    const signerAddressCallsByChain: Record<string, number> = {};
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          signerAddressCallsByChain[chainName] =
            (signerAddressCallsByChain[chainName] ?? 0) + 1;
          if (chainName === CHAIN) {
            return SIGNER;
          }
          throw new Error(`unexpected signer lookup for ${chainName}`);
        },
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          if (domainId === 31347) return 'anvil3';
          throw new Error('unknown domain');
        },
        tryGetSigner: (chainName: string) => {
          tryGetSignerCalls += 1;
          if (chainName === 'anvil3') return null;
          return {};
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x2222222222222222222222222222222222222222' } as any,
        ],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(tryGetSignerCalls).to.equal(1);
      expect(provider.getLogs.callCount).to.equal(2);
      expect(signerAddressCallsByChain[CHAIN]).to.equal(1);
      expect(signerAddressCallsByChain.anvil3 ?? 0).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches negative ICA inference results per destination chain and account', async () => {
    const inferredIcaOwner = '0x4545454545454545454545454545454545454545';
    const destinationRouterAddress =
      '0x6767676767676767676767676767676767676767';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches timelock proposer inference per chain and timelock', async () => {
    const timelockOwner = '0x5555555555555555555555555555555555555555';
    const tx1 = { ...TX, to: '0xabababababababababababababababababababab' };
    const tx2 = { ...TX, to: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: SIGNER } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [tx1 as any, tx2 as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      // first inference call scans granted+revoked logs, second tx reuses cache
      expect(provider.getLogs.callCount).to.equal(2);
      expect(timelockStub.callCount).to.be.greaterThan(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to default timelock proposer when hasRole checks fail', async () => {
    const timelockOwner = '0x5555555555555555555555555555555555555555';
    const tx1 = { ...TX, to: '0xabababababababababababababababababababab' };
    const tx2 = { ...TX, to: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };
    const hasRoleStub = sinon.stub().callsFake(async () => {
      throw new Error('role lookup failed');
    });
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: hasRoleStub,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: SIGNER } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [tx1 as any, tx2 as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
      // first inference performs open-role and signer-role checks; second tx reuses cache
      expect(hasRoleStub.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('uses default timelock proposer when proposer role is open', async () => {
    const timelockOwner = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
    const tx1 = { ...TX, to: '0xabababababababababababababababababababab' };
    const tx2 = { ...TX, to: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };
    const hasRoleStub = sinon
      .stub()
      .callsFake(async (_role: string, account: string) =>
        eqAddress(account, ethersConstants.AddressZero),
      );
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: hasRoleStub,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: SIGNER } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [tx1 as any, tx2 as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].transactions).to.have.length(2);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
      // first inference checks open role and signer role once; second tx reuses cache
      expect(hasRoleStub.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('uses default timelock proposer when signer has proposer role', async () => {
    const timelockOwner = '0x6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a';
    const tx1 = { ...TX, to: '0xabababababababababababababababababababab' };
    const tx2 = { ...TX, to: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };
    const hasRoleStub = sinon
      .stub()
      .callsFake(async (_role: string, account: string) =>
        eqAddress(account, SIGNER),
      );
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: hasRoleStub,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: SIGNER } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [tx1 as any, tx2 as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].transactions).to.have.length(2);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
      // first inference checks open role and signer role once; second tx reuses cache
      expect(hasRoleStub.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('reuses cached signer during timelock proposer inference', async () => {
    const timelockOwner = '0x5555555555555555555555555555555555555555';
    const tx1 = { ...TX, to: '0xabababababababababababababababababababab' };
    const tx2 = { ...TX, to: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };
    const hasRoleStub = sinon.stub().resolves(false);
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: hasRoleStub,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: SIGNER } }),
        },
      } as any);

    let signerAddressCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => {
          signerAddressCalls += 1;
          if (signerAddressCalls === 2) {
            throw new Error('signer lookup failed');
          }
          return SIGNER;
        },
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [tx1 as any, tx2 as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      // first inference queries granted+revoked logs, second tx reuses cache
      expect(provider.getLogs.callCount).to.equal(2);
      expect(hasRoleStub.callCount).to.equal(2);
      // signer address is resolved once and reused from cache
      expect(signerAddressCalls).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to default timelock proposer when role log queries fail', async () => {
    const timelockOwner = '0x5555555555555555555555555555555555555555';
    const tx1 = { ...TX, to: '0xabababababababababababababababababababab' };
    const tx2 = { ...TX, to: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().rejects(new Error('log query failed')),
    };
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: SIGNER } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [tx1 as any, tx2 as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      // granted + revoked queries attempted once; second tx reuses cache
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to default timelock proposer when role topics cannot be derived', async () => {
    const timelockOwner = '0x5555555555555555555555555555555555555555';
    const tx1 = { ...TX, to: '0xabababababababababababababababababababab' };
    const tx2 = { ...TX, to: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: () => {
            throw new Error('topic lookup failed');
          },
          parseLog: (_log: unknown) => ({ args: { account: SIGNER } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [tx1 as any, tx2 as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores malformed timelock proposer role logs and still caches result', async () => {
    const timelockOwner = '0x5555555555555555555555555555555555555555';
    const tx1 = { ...TX, to: '0xabababababababababababababababababababab' };
    const tx2 = { ...TX, to: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().resolves([{ topics: [], data: '0x' }]),
    };
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => {
            throw new Error('malformed role event');
          },
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [tx1 as any, tx2 as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('uses valid timelock proposer role logs even when some logs are malformed', async () => {
    const timelockOwner = '0x5555555555555555555555555555555555555555';
    const safeProposer = '0x6666666666666666666666666666666666666666';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const malformedLog = { topics: ['0xmalformed'], data: '0x' };
    const validGrantedLog = { topics: ['0xvalid-granted'], data: '0x' };
    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [malformedLog, validGrantedLog];
        }
        return [];
      }),
    };
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (log: any) => {
            if (log === malformedLog) {
              throw new Error('malformed role event');
            }
            return { args: { account: safeProposer } };
          },
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect((batches[0].config.submitter as any).proposerSubmitter.safeAddress)
        .to.equal(safeProposer);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('respects chronological role grant/revoke order for timelock proposers', async () => {
    const timelockOwner = '0x5656565656565656565656565656565656565656';
    const safeProposer = '0x6767676767676767676767676767676767676767';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const grantedEarly = {
      topics: ['0xgranted-early'],
      data: '0x',
      blockNumber: 100,
      transactionIndex: 0,
      logIndex: 1,
    };
    const revokedMid = {
      topics: ['0xrevoked-mid'],
      data: '0x',
      blockNumber: 101,
      transactionIndex: 0,
      logIndex: 1,
    };
    const grantedLate = {
      topics: ['0xgranted-late'],
      data: '0x',
      blockNumber: 102,
      transactionIndex: 0,
      logIndex: 1,
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [grantedEarly, grantedLate];
        }
        return [revokedMid];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('reconstructs timelock proposer roles correctly from unsorted role logs', async () => {
    const timelockOwner = '0x5858585858585858585858585858585858585858';
    const safeProposer = '0x6969696969696969696969696969696969696969';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const earlyGrant = {
      topics: ['0xgrant-early'],
      data: '0x',
      blockNumber: 100,
      transactionIndex: 0,
      logIndex: 1,
    };
    const midRevoke = {
      topics: ['0xrevoke-mid'],
      data: '0x',
      blockNumber: 101,
      transactionIndex: 0,
      logIndex: 1,
    };
    const lateGrant = {
      topics: ['0xgrant-late'],
      data: '0x',
      blockNumber: 102,
      transactionIndex: 0,
      logIndex: 1,
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          // intentionally unsorted newest-first
          return [lateGrant, earlyGrant];
        }
        return [midRevoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect((batches[0].config.submitter as any).proposerSubmitter.safeAddress)
        .to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('uses transaction/log index ordering for timelock role logs in same block', async () => {
    const timelockOwner = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
    const safeProposer = '0x6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const earlyGrant = {
      topics: ['0xgrant-early'],
      data: '0x',
      blockNumber: 300,
      transactionIndex: 1,
      logIndex: 2,
    };
    const middleRevoke = {
      topics: ['0xrevoke-middle'],
      data: '0x',
      blockNumber: 300,
      transactionIndex: 2,
      logIndex: 10,
    };
    const lateGrant = {
      topics: ['0xgrant-late'],
      data: '0x',
      blockNumber: 300,
      transactionIndex: 3,
      logIndex: 1,
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          // intentionally unsorted newest-first
          return [lateGrant, earlyGrant];
        }
        return [middleRevoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('uses log index ordering for timelock role logs in same transaction', async () => {
    const timelockOwner = '0x5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b';
    const safeProposer = '0x6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const earlyGrant = {
      topics: ['0xgrant-early'],
      data: '0x',
      blockNumber: 400,
      transactionIndex: 7,
      logIndex: 10,
    };
    const middleRevoke = {
      topics: ['0xrevoke-middle'],
      data: '0x',
      blockNumber: 400,
      transactionIndex: 7,
      logIndex: 11,
    };
    const lateGrant = {
      topics: ['0xgrant-late'],
      data: '0x',
      blockNumber: 400,
      transactionIndex: 7,
      logIndex: 12,
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          // intentionally unsorted newest-first
          return [lateGrant, earlyGrant];
        }
        return [middleRevoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('handles bigint timelock role positional fields deterministically', async () => {
    const timelockOwner = '0x5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c';
    const safeProposer = '0x6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const olderGrant = {
      topics: ['0xgrant-older'],
      data: '0x',
      blockNumber: 600n,
      transactionIndex: 1n,
      logIndex: 1n,
    };
    const newerGrant = {
      topics: ['0xgrant-newer'],
      data: '0x',
      blockNumber: 601n,
      transactionIndex: 0n,
      logIndex: 0n,
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: 600n,
      transactionIndex: 2n,
      logIndex: 0n,
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [olderGrant, newerGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('handles very large bigint timelock role positions without precision loss', async () => {
    const timelockOwner = '0x6262626262626262626262626262626262626262';
    const safeProposer = '0x7373737373737373737373737373737373737373';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const newerGrant = {
      topics: ['0xgrant-newer'],
      data: '0x',
      blockNumber: 9007199254740994n,
      transactionIndex: 0n,
      logIndex: 0n,
    };
    const olderRevoke = {
      topics: ['0xrevoke-older'],
      data: '0x',
      blockNumber: 9007199254740993n,
      transactionIndex: 0n,
      logIndex: 0n,
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [newerGrant];
        }
        return [olderRevoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('handles BigNumber-like timelock role positional fields deterministically', async () => {
    const timelockOwner = '0x5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d';
    const safeProposer = '0x6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e';
    const asBigNumberLike = (value: string) =>
      ({
        toString: () => value,
      }) as any;

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const olderGrant = {
      topics: ['0xgrant-older'],
      data: '0x',
      blockNumber: asBigNumberLike('800'),
      transactionIndex: asBigNumberLike('1'),
      logIndex: asBigNumberLike('1'),
    };
    const newerGrant = {
      topics: ['0xgrant-newer'],
      data: '0x',
      blockNumber: asBigNumberLike('801'),
      transactionIndex: asBigNumberLike('0'),
      logIndex: asBigNumberLike('0'),
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: asBigNumberLike('800'),
      transactionIndex: asBigNumberLike('2'),
      logIndex: asBigNumberLike('0'),
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [olderGrant, newerGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('handles string-encoded timelock role positional fields deterministically', async () => {
    const timelockOwner = '0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e';
    const safeProposer = '0x6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const olderGrant = {
      topics: ['0xgrant-older'],
      data: '0x',
      blockNumber: '1000',
      transactionIndex: '1',
      logIndex: '1',
    };
    const newerGrant = {
      topics: ['0xgrant-newer'],
      data: '0x',
      blockNumber: ' 1001 ',
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '1000',
      transactionIndex: '2',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [olderGrant, newerGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('handles hex-string timelock role positional fields deterministically', async () => {
    const timelockOwner = '0x5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f';
    const safeProposer = '0x7070707070707070707070707070707070707070';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const olderGrant = {
      topics: ['0xgrant-older'],
      data: '0x',
      blockNumber: '0x500',
      transactionIndex: '0x1',
      logIndex: '0x1',
    };
    const newerGrant = {
      topics: ['0xgrant-newer'],
      data: '0x',
      blockNumber: '0x501',
      transactionIndex: '0x0',
      logIndex: '0x0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '0x500',
      transactionIndex: '0x2',
      logIndex: '0x0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [olderGrant, newerGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('handles uppercase hex-string timelock role positional fields deterministically', async () => {
    const timelockOwner = '0x6464646464646464646464646464646464646464';
    const safeProposer = '0x7575757575757575757575757575757575757575';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const olderGrant = {
      topics: ['0xgrant-older'],
      data: '0x',
      blockNumber: '0X600',
      transactionIndex: '0X1',
      logIndex: '0X1',
    };
    const newerGrant = {
      topics: ['0xgrant-newer'],
      data: '0x',
      blockNumber: '0X601',
      transactionIndex: '0X0',
      logIndex: '0X0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '0X600',
      transactionIndex: '0X2',
      logIndex: '0X0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [olderGrant, newerGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('handles whitespace-padded hex timelock role positional fields deterministically', async () => {
    const timelockOwner = '0x6565656565656565656565656565656565656565';
    const safeProposer = '0x7676767676767676767676767676767676767676';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const olderGrant = {
      topics: ['0xgrant-older'],
      data: '0x',
      blockNumber: ' 0x800 ',
      transactionIndex: ' 0x1 ',
      logIndex: ' 0x1 ',
    };
    const newerGrant = {
      topics: ['0xgrant-newer'],
      data: '0x',
      blockNumber: ' 0X801 ',
      transactionIndex: ' 0X0 ',
      logIndex: ' 0X0 ',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: ' 0x800 ',
      transactionIndex: ' 0x2 ',
      logIndex: ' 0x0 ',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [olderGrant, newerGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('handles very large decimal-string timelock role positions without precision loss', async () => {
    const timelockOwner = '0x6969696969696969696969696969696969696969';
    const safeProposer = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const newerGrant = {
      topics: ['0xgrant-newer'],
      data: '0x',
      blockNumber: '900719925474099312345679',
      transactionIndex: '0',
      logIndex: '0',
    };
    const olderRevoke = {
      topics: ['0xrevoke-older'],
      data: '0x',
      blockNumber: '900719925474099312345678',
      transactionIndex: '1',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [newerGrant];
        }
        return [olderRevoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores malformed hex-string timelock role positions during ordering', async () => {
    const timelockOwner = '0x6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a';
    const safeProposer = '0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1000',
      transactionIndex: '1',
      logIndex: '1',
    };
    const malformedHigherGrant = {
      topics: ['0xgrant-malformed-high'],
      data: '0x',
      blockNumber: '0xABCX',
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '999',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          // malformed hex grant should not outrank valid grant
          return [validGrant, malformedHigherGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores empty-hex-prefix timelock role positions during ordering', async () => {
    const timelockOwner = '0x6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b';
    const safeProposer = '0x7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1001',
      transactionIndex: '1',
      logIndex: '1',
    };
    const malformedHexPrefixGrant = {
      topics: ['0xgrant-malformed-prefix'],
      data: '0x',
      blockNumber: '0x',
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '1000',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          // empty hex prefix must not outrank valid proposer role event
          return [validGrant, malformedHexPrefixGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores non-integer string timelock role positions during ordering', async () => {
    const timelockOwner = '0x6060606060606060606060606060606060606060';
    const safeProposer = '0x7171717171717171717171717171717171717171';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1000',
      transactionIndex: '1',
      logIndex: '1',
    };
    const malformedHigherGrant = {
      topics: ['0xgrant-malformed-high'],
      data: '0x',
      blockNumber: '9999.9',
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '999',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          // malformed grant appears later in array but should not outrank valid grant
          return [validGrant, malformedHigherGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores plus-prefixed decimal-string timelock role positions during ordering', async () => {
    const timelockOwner = '0x6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c';
    const safeProposer = '0x7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1002',
      transactionIndex: '1',
      logIndex: '1',
    };
    const malformedPlusGrant = {
      topics: ['0xgrant-malformed-plus'],
      data: '0x',
      blockNumber: '+9999',
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '1001',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [validGrant, malformedPlusGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores overlong hex-string timelock role positions during ordering', async () => {
    const timelockOwner = '0x6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d';
    const safeProposer = '0x7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1003',
      transactionIndex: '1',
      logIndex: '1',
    };
    const malformedOverlongGrant = {
      topics: ['0xgrant-malformed-overlong'],
      data: '0x',
      blockNumber: `0x${'f'.repeat(300)}`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '1002',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [validGrant, malformedOverlongGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('accepts max-length hex-string timelock role positions deterministically', async () => {
    const timelockOwner = '0x8282828282828282828282828282828282828282';
    const safeProposer = '0x8383838383838383838383838383838383838383';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const higherGrant = {
      topics: ['0xgrant-higher'],
      data: '0x',
      blockNumber: `0x${'f'.repeat(254)}`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const lowerRevoke = {
      topics: ['0xrevoke-lower'],
      data: '0x',
      blockNumber: `0x${'f'.repeat(253)}`,
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [higherGrant];
        }
        return [lowerRevoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('accepts overlong zero-padded hex timelock role positions deterministically', async () => {
    const timelockOwner = '0x8888888888888888888888888888888888888888';
    const safeProposer = '0x8989898989898989898989898989898989898989';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const higherGrant = {
      topics: ['0xgrant-higher'],
      data: '0x',
      blockNumber: `0x${'0'.repeat(300)}2`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const lowerRevoke = {
      topics: ['0xrevoke-lower'],
      data: '0x',
      blockNumber: `0x${'0'.repeat(300)}1`,
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [higherGrant];
        }
        return [lowerRevoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores overlong decimal-string timelock role positions during ordering', async () => {
    const timelockOwner = '0x6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e';
    const safeProposer = '0x7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1004',
      transactionIndex: '1',
      logIndex: '1',
    };
    const malformedOverlongGrant = {
      topics: ['0xgrant-malformed-overlong-decimal'],
      data: '0x',
      blockNumber: '9'.repeat(300),
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '1003',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [validGrant, malformedOverlongGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('accepts overlong zero-padded decimal timelock role positions deterministically', async () => {
    const timelockOwner = '0x8686868686868686868686868686868686868686';
    const safeProposer = '0x8787878787878787878787878787878787878787';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const higherGrant = {
      topics: ['0xgrant-higher'],
      data: '0x',
      blockNumber: `${'0'.repeat(300)}2`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const lowerRevoke = {
      topics: ['0xrevoke-lower'],
      data: '0x',
      blockNumber: `${'0'.repeat(300)}1`,
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [higherGrant];
        }
        return [lowerRevoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores excessively long raw decimal timelock role positions during ordering', async () => {
    const timelockOwner = '0x8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a';
    const safeProposer = '0x8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1006',
      transactionIndex: '1',
      logIndex: '1',
    };
    const malformedRawLengthGrant = {
      topics: ['0xgrant-malformed-raw-length'],
      data: '0x',
      blockNumber: `${'0'.repeat(5000)}2`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '1005',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [validGrant, malformedRawLengthGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores excessively long raw whitespace-padded timelock role positions during ordering', async () => {
    const timelockOwner = '0x8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e';
    const safeProposer = '0x8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f';
    const malformedProposer = '0x9090909090909090909090909090909090909090';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1008',
      transactionIndex: '1',
      logIndex: '1',
    };
    const malformedRawWhitespaceGrant = {
      topics: ['0xgrant-malformed-raw-whitespace'],
      data: '0x',
      blockNumber: `${' '.repeat(5000)}9999`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '1007',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [validGrant, malformedRawWhitespaceGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (log: any) => ({
            args: {
              account: log === validGrant ? safeProposer : malformedProposer,
            },
          }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('accepts raw-length-boundary whitespace-padded timelock role positions deterministically', async () => {
    const timelockOwner = '0x9191919191919191919191919191919191919191';
    const safeProposer = '0x9292929292929292929292929292929292929292';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const higherGrant = {
      topics: ['0xgrant-higher'],
      data: '0x',
      blockNumber: `${' '.repeat(4095)}2`,
      transactionIndex: '0',
      logIndex: '0',
    };
    const lowerRevoke = {
      topics: ['0xrevoke-lower'],
      data: '0x',
      blockNumber: `${' '.repeat(4095)}1`,
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [higherGrant];
        }
        return [lowerRevoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('accepts max-length decimal-string timelock role positions deterministically', async () => {
    const timelockOwner = '0x8484848484848484848484848484848484848484';
    const safeProposer = '0x8585858585858585858585858585858585858585';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const higherGrant = {
      topics: ['0xgrant-higher'],
      data: '0x',
      blockNumber: '1'.repeat(256),
      transactionIndex: '0',
      logIndex: '0',
    };
    const lowerRevoke = {
      topics: ['0xrevoke-lower'],
      data: '0x',
      blockNumber: '9'.repeat(255),
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [higherGrant];
        }
        return [lowerRevoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores overlong toString timelock role positions during ordering', async () => {
    const timelockOwner = '0x8080808080808080808080808080808080808080';
    const safeProposer = '0x8181818181818181818181818181818181818181';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1005',
      transactionIndex: '1',
      logIndex: '1',
    };
    const malformedToStringGrant = {
      topics: ['0xgrant-malformed-tostring-overlong'],
      data: '0x',
      blockNumber: {
        toString: () => `0x${'f'.repeat(300)}`,
      },
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '1004',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [validGrant, malformedToStringGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores excessively long raw toString timelock role positions during ordering', async () => {
    const timelockOwner = '0x8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c';
    const safeProposer = '0x8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1007',
      transactionIndex: '1',
      logIndex: '1',
    };
    const malformedRawToStringGrant = {
      topics: ['0xgrant-malformed-raw-tostring'],
      data: '0x',
      blockNumber: {
        toString: () => `${'0'.repeat(5000)}2`,
      },
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '1006',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [validGrant, malformedRawToStringGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores non-string toString timelock role positions during ordering', async () => {
    const timelockOwner = '0x6161616161616161616161616161616161616161';
    const safeProposer = '0x7272727272727272727272727272727272727272';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1200',
      transactionIndex: '1',
      logIndex: '1',
    };
    const malformedGrant = {
      topics: ['0xgrant-malformed'],
      data: '0x',
      blockNumber: {
        toString: () => ({}) as any,
      },
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '1199',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [validGrant, malformedGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores throwing toString timelock role positions during ordering', async () => {
    const timelockOwner = '0x6767676767676767676767676767676767676767';
    const safeProposer = '0x7878787878787878787878787878787878787878';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1600',
      transactionIndex: '1',
      logIndex: '1',
    };
    const malformedGrant = {
      topics: ['0xgrant-malformed'],
      data: '0x',
      blockNumber: {
        toString: () => {
          throw new Error('toString failed');
        },
      },
      transactionIndex: '0',
      logIndex: '0',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '1599',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [validGrant, malformedGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores unsafe-number timelock role positions during ordering', async () => {
    const timelockOwner = '0x6363636363636363636363636363636363636363';
    const safeProposer = '0x7474747474747474747474747474747474747474';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: 1400,
      transactionIndex: 1,
      logIndex: 1,
    };
    const malformedGrant = {
      topics: ['0xgrant-malformed'],
      data: '0x',
      blockNumber: 1e20,
      transactionIndex: 0,
      logIndex: 0,
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: 1399,
      transactionIndex: 0,
      logIndex: 0,
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [validGrant, malformedGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores fractional-number timelock role positions during ordering', async () => {
    const timelockOwner = '0x6868686868686868686868686868686868686868';
    const safeProposer = '0x7979797979797979797979797979797979797979';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: 1800,
      transactionIndex: 1,
      logIndex: 1,
    };
    const malformedGrant = {
      topics: ['0xgrant-malformed'],
      data: '0x',
      blockNumber: 1800.5,
      transactionIndex: 0,
      logIndex: 0,
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: 1799,
      transactionIndex: 0,
      logIndex: 0,
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [validGrant, malformedGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: safeProposer } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('ignores malformed proposer account addresses in timelock role logs', async () => {
    const timelockOwner = '0x5555555555555555555555555555555555555555';
    const safeProposer = '0x6666666666666666666666666666666666666666';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );

    const checkedSafeAddresses: string[] = [];
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        checkedSafeAddresses.push(address.toLowerCase());
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      },
    );

    const invalidAccountLog = { topics: ['0xinvalid-account'], data: '0x' };
    const validGrantedLog = { topics: ['0xvalid-granted'], data: '0x' };
    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [invalidAccountLog, validGrantedLog];
        }
        return [];
      }),
    };
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (log: any) => {
            if (log === invalidAccountLog) {
              return { args: { account: 'not-an-address' } };
            }
            return { args: { account: safeProposer } };
          },
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect((batches[0].config.submitter as any).proposerSubmitter.safeAddress)
        .to.equal(safeProposer);
      expect(checkedSafeAddresses).to.deep.equal([
        timelockOwner.toLowerCase(),
        safeProposer.toLowerCase(),
      ]);
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to default timelock proposer when registry lookup fails', async () => {
    const timelockOwner = '0x7777777777777777777777777777777777777777';
    const nonSafeProposer = '0x8888888888888888888888888888888888888888';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [{ topics: ['0xvalid-granted'], data: '0x' }];
        }
        return [];
      }),
    };
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: nonSafeProposer } }),
        },
      } as any);

    let registryReads = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => {
          registryReads += 1;
          throw new Error('registry unavailable');
        },
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          TX as any,
          { ...TX, to: '0x9999999999999999999999999999999999999999' } as any,
        ],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(registryReads).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to default timelock proposer when destination router address is invalid', async () => {
    const timelockOwner = '0x7979797979797979797979797979797979797979';
    const nonSafeProposer = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [{ topics: ['0xvalid-granted'], data: '0x' }];
        }
        return [];
      }),
    };
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: () => ({ args: { account: nonSafeProposer } }),
        },
      } as any);

    let registryReads = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => {
          registryReads += 1;
          return {
            [CHAIN]: {
              interchainAccountRouter: 'not-an-address',
            },
            anvil3: {
              interchainAccountRouter:
                '0x8888888888888888888888888888888888888888',
            },
          };
        },
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, { ...TX, to: '0x9999999999999999999999999999999999999999' } as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(registryReads).to.equal(1);
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('infers timelock proposer ICA from proposer role account derivation', async () => {
    const timelockOwner = '0x5555555555555555555555555555555555555555';
    const proposerIca = '0x6666666666666666666666666666666666666666';
    const destinationRouterAddress =
      '0x7777777777777777777777777777777777777777';
    const originRouterAddress = '0x8888888888888888888888888888888888888888';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => timelockOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.address === timelockOwner && filter.topics?.[0] === 'RoleGranted') {
          return [{ topics: [], data: '0x' }];
        }
        return [];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: proposerIca } }),
        },
      } as any);

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              proposerIca,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.INTERCHAIN_ACCOUNT);
      expect((batches[0].config.submitter as any).proposerSubmitter.owner).to.equal(
        SIGNER,
      );
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('infers timelock proposer ICA from signer-derived fallback when role logs are empty', async () => {
    const timelockOwner = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const derivedIcaProposer = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const destinationRouterAddress =
      '0xcccccccccccccccccccccccccccccccccccccccc';
    const originRouterAddress = '0xdddddddddddddddddddddddddddddddddddddddd';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => timelockOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async (_role: string, account: string) =>
          account.toLowerCase() === derivedIcaProposer.toLowerCase(),
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: SIGNER } }),
        },
      } as any);

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              derivedIcaProposer,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.INTERCHAIN_ACCOUNT);
      expect((batches[0].config.submitter as any).proposerSubmitter.owner).to.equal(
        SIGNER,
      );
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('ignores unknown registry chains while deriving timelock ICA proposer fallback', async () => {
    const timelockOwner = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const derivedIcaProposer = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const destinationRouterAddress =
      '0xcccccccccccccccccccccccccccccccccccccccc';
    const originRouterAddress = '0xdddddddddddddddddddddddddddddddddddddddd';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => timelockOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async (_role: string, account: string) =>
          account.toLowerCase() === derivedIcaProposer.toLowerCase(),
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: SIGNER } }),
        },
      } as any);

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              derivedIcaProposer,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: (chainName: string) => {
          if (chainName === 'unknownChain') {
            throw new Error('unknown chain metadata');
          }
          return ProtocolType.Ethereum;
        },
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          unknownChain: {
            interchainAccountRouter:
              '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.INTERCHAIN_ACCOUNT);
      expect((batches[0].config.submitter as any).proposerSubmitter.owner).to.equal(
        SIGNER,
      );
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches protocol checks while deriving timelock ICA proposer fallback', async () => {
    const timelockOwnerA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const timelockOwnerB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const derivedIcaProposer = '0xcccccccccccccccccccccccccccccccccccccccc';
    const destinationRouterAddress =
      '0xdddddddddddddddddddddddddddddddddddddddd';
    const originRouterAddress = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

    const ownerByTarget: Record<string, string> = {
      '0x1111111111111111111111111111111111111111': timelockOwnerA,
      '0x2222222222222222222222222222222222222222': timelockOwnerB,
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () => ownerByTarget[targetAddress.toLowerCase()],
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .callsFake(() => ({
        getMinDelay: async () => 0,
        hasRole: async (_role: string, account: string) =>
          account.toLowerCase() === derivedIcaProposer.toLowerCase(),
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: SIGNER } }),
        },
      }) as any);

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              derivedIcaProposer,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const protocolCalls: Record<string, number> = {};
    let registryReads = 0;
    const context = {
      multiProvider: {
        getProtocol: (chainName: string) => {
          protocolCalls[chainName] = (protocolCalls[chainName] ?? 0) + 1;
          if (chainName === 'unknownChain') {
            throw new Error('unknown chain metadata');
          }
          return ProtocolType.Ethereum;
        },
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => {
          registryReads += 1;
          return {
            [CHAIN]: {
              interchainAccountRouter: destinationRouterAddress,
            },
            unknownChain: {
              interchainAccountRouter:
                '0xffffffffffffffffffffffffffffffffffffffff',
            },
            anvil3: {
              interchainAccountRouter: originRouterAddress,
            },
          };
        },
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x2222222222222222222222222222222222222222' } as any,
        ],
        context,
      });

      expect(batches).to.have.length(2);
      expect(protocolCalls.unknownChain).to.equal(1);
      expect(protocolCalls.anvil3).to.equal(1);
      expect(registryReads).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when timelock ICA origin signer is unavailable', async () => {
    const timelockOwner = '0x1111111111111111111111111111111111111111';
    const proposerIca = '0x2222222222222222222222222222222222222222';
    const destinationRouterAddress =
      '0x3333333333333333333333333333333333333333';
    const originRouterAddress = '0x4444444444444444444444444444444444444444';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => timelockOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.address === timelockOwner && filter.topics?.[0] === 'RoleGranted') {
          return [{ topics: [], data: '0x' }];
        }
        return [];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: proposerIca } }),
        },
      } as any);

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              proposerIca,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        tryGetSigner: (chainName: string) => (chainName === CHAIN ? {} : null),
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when timelock ICA origin signer lookup fails without tryGetSigner', async () => {
    const timelockOwner = '0x5151515151515151515151515151515151515151';
    const proposerIca = '0x5252525252525252525252525252525252525252';
    const destinationRouterAddress =
      '0x5353535353535353535353535353535353535353';
    const originRouterAddress = '0x5454545454545454545454545454545454545454';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => timelockOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.address === timelockOwner && filter.topics?.[0] === 'RoleGranted') {
          return [{ topics: [], data: '0x' }];
        }
        return [];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: proposerIca } }),
        },
      } as any);

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              proposerIca,
          } as any;
        }

        throw new Error('unexpected router');
      });

    let signerAddressCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          signerAddressCalls += 1;
          if (chainName === CHAIN) {
            return SIGNER;
          }
          throw new Error('origin signer unavailable');
        },
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(signerAddressCalls).to.equal(2);
      expect(provider.getLogs.callCount).to.equal(3);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches no-tryGetSigner origin signer lookup failures across timelock ICA inferences', async () => {
    const timelockOwnerA = '0x8181818181818181818181818181818181818181';
    const timelockOwnerB = '0x8282828282828282828282828282828282828282';
    const proposerIca = '0x8383838383838383838383838383838383838383';
    const destinationRouterAddress =
      '0x8484848484848484848484848484848484848484';
    const originRouterAddress = '0x8585858585858585858585858585858585858585';

    const ownerByTarget: Record<string, string> = {
      '0x1111111111111111111111111111111111111111': timelockOwnerA,
      '0x2222222222222222222222222222222222222222': timelockOwnerB,
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () => ownerByTarget[targetAddress.toLowerCase()],
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (
          (filter.address === timelockOwnerA || filter.address === timelockOwnerB) &&
          filter.topics?.[0] === 'RoleGranted'
        ) {
          return [{ topics: [], data: '0x' }];
        }
        return [];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: proposerIca } }),
        },
      } as any);

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              proposerIca,
          } as any;
        }

        throw new Error('unexpected router');
      });

    let signerAddressCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          signerAddressCalls += 1;
          if (chainName === CHAIN) {
            return SIGNER;
          }
          throw new Error('origin signer unavailable');
        },
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x2222222222222222222222222222222222222222' } as any,
        ],
        context,
      });

      expect(batches).to.have.length(2);
      expect(batches[0].transactions).to.have.length(1);
      expect(batches[1].transactions).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(batches[1].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[1].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(signerAddressCalls).to.equal(2);
      expect(provider.getLogs.callCount).to.equal(5);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches unavailable origin signer probes across timelock ICA inferences', async () => {
    const timelockOwnerA = '0x8686868686868686868686868686868686868686';
    const timelockOwnerB = '0x8787878787878787878787878787878787878787';
    const proposerIca = '0x8888888888888888888888888888888888888888';
    const destinationRouterAddress =
      '0x8989898989898989898989898989898989898989';
    const originRouterAddress = '0x8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a';

    const ownerByTarget: Record<string, string> = {
      '0x1111111111111111111111111111111111111111': timelockOwnerA,
      '0x2222222222222222222222222222222222222222': timelockOwnerB,
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () => ownerByTarget[targetAddress.toLowerCase()],
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (
          (filter.address === timelockOwnerA || filter.address === timelockOwnerB) &&
          filter.topics?.[0] === 'RoleGranted'
        ) {
          return [{ topics: [], data: '0x' }];
        }
        return [];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: proposerIca } }),
        },
      } as any);

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              proposerIca,
          } as any;
        }

        throw new Error('unexpected router');
      });

    let originSignerProbeCalls = 0;
    let originSignerAddressLookups = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          if (chainName === CHAIN) return SIGNER;
          originSignerAddressLookups += 1;
          throw new Error(`unexpected signer lookup for ${chainName}`);
        },
        getProvider: () => provider,
        tryGetSigner: (chainName: string) => {
          if (chainName === CHAIN) return {};
          originSignerProbeCalls += 1;
          return null;
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x2222222222222222222222222222222222222222' } as any,
        ],
        context,
      });

      expect(batches).to.have.length(2);
      expect(batches[0].transactions).to.have.length(1);
      expect(batches[1].transactions).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(batches[1].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[1].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(originSignerProbeCalls).to.equal(1);
      expect(originSignerAddressLookups).to.equal(0);
      expect(provider.getLogs.callCount).to.equal(5);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('avoids origin signer address lookup when timelock ICA origin signer is unavailable', async () => {
    const timelockOwner = '0x1010101010101010101010101010101010101010';
    const proposerIca = '0x2020202020202020202020202020202020202020';
    const destinationRouterAddress =
      '0x3030303030303030303030303030303030303030';
    const originRouterAddress = '0x4040404040404040404040404040404040404040';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => timelockOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.address === timelockOwner && filter.topics?.[0] === 'RoleGranted') {
          return [{ topics: [], data: '0x' }];
        }
        return [];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: proposerIca } }),
        },
      } as any);

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              proposerIca,
          } as any;
        }

        throw new Error('unexpected router');
      });

    let originSignerAddressLookups = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          if (chainName === CHAIN) return SIGNER;
          originSignerAddressLookups += 1;
          throw new Error(`unexpected signer lookup for ${chainName}`);
        },
        getProvider: () => provider,
        tryGetSigner: (chainName: string) => (chainName === CHAIN ? {} : null),
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(originSignerAddressLookups).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when timelock ICA origin signer probe throws', async () => {
    const timelockOwner = '0x7171717171717171717171717171717171717171';
    const proposerIca = '0x7272727272727272727272727272727272727272';
    const destinationRouterAddress =
      '0x7373737373737373737373737373737373737373';
    const originRouterAddress = '0x7474747474747474747474747474747474747474';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => timelockOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.address === timelockOwner && filter.topics?.[0] === 'RoleGranted') {
          return [{ topics: [], data: '0x' }];
        }
        return [];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: proposerIca } }),
        },
      } as any);

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              proposerIca,
          } as any;
        }

        throw new Error('unexpected router');
      });

    let originSignerAddressLookups = 0;
    let originSignerProbeCalls = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          if (chainName === CHAIN) return SIGNER;
          originSignerAddressLookups += 1;
          throw new Error(`unexpected signer lookup for ${chainName}`);
        },
        getProvider: () => provider,
        tryGetSigner: (chainName: string) => {
          if (chainName === CHAIN) return {};
          originSignerProbeCalls += 1;
          throw new Error(`origin signer probe failed for ${chainName}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any, TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(originSignerAddressLookups).to.equal(0);
      expect(originSignerProbeCalls).to.equal(1);
      expect(provider.getLogs.callCount).to.equal(3);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('caches throwing origin signer probes across timelock ICA inferences', async () => {
    const timelockOwnerA = '0x7575757575757575757575757575757575757575';
    const timelockOwnerB = '0x7676767676767676767676767676767676767676';
    const proposerIca = '0x7777777777777777777777777777777777777777';
    const destinationRouterAddress =
      '0x7878787878787878787878787878787878787878';
    const originRouterAddress = '0x7979797979797979797979797979797979797979';

    const ownerByTarget: Record<string, string> = {
      '0x1111111111111111111111111111111111111111': timelockOwnerA,
      '0x2222222222222222222222222222222222222222': timelockOwnerB,
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () => ownerByTarget[targetAddress.toLowerCase()],
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (
          (filter.address === timelockOwnerA || filter.address === timelockOwnerB) &&
          filter.topics?.[0] === 'RoleGranted'
        ) {
          return [{ topics: [], data: '0x' }];
        }
        return [];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: proposerIca } }),
        },
      } as any);

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              proposerIca,
          } as any;
        }

        throw new Error('unexpected router');
      });

    let originSignerProbeCalls = 0;
    let originSignerAddressLookups = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          if (chainName === CHAIN) return SIGNER;
          originSignerAddressLookups += 1;
          throw new Error(`unexpected signer lookup for ${chainName}`);
        },
        getProvider: () => provider,
        tryGetSigner: (chainName: string) => {
          if (chainName === CHAIN) return {};
          originSignerProbeCalls += 1;
          throw new Error(`origin signer probe failed for ${chainName}`);
        },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x2222222222222222222222222222222222222222' } as any,
        ],
        context,
      });

      expect(batches).to.have.length(2);
      expect(batches[0].transactions).to.have.length(1);
      expect(batches[1].transactions).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(batches[1].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[1].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(originSignerProbeCalls).to.equal(1);
      expect(originSignerAddressLookups).to.equal(0);
      expect(provider.getLogs.callCount).to.equal(5);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });
});
