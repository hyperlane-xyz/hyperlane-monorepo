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
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
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
});
