import { expect } from 'chai';
import { constants as ethersConstants } from 'ethers';
import sinon from 'sinon';

import {
  ISafe__factory,
  InterchainAccountRouter__factory,
  Ownable__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { getRequiredRuntimeFunctionValueByLabel } from './inference.runtime-globals.js';

describe('resolveSubmitterBatchesForTransactions dataview constructor probes', () => {
  const CHAIN = 'anvil2';
  const SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };
  const DATAVIEW_CONSTRUCTOR_PROBE = getRequiredRuntimeFunctionValueByLabel(
    'dataview-constructor-object',
  );

  const expectTimelockJsonRpcBatches = (batches: any[]) => {
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
  };

  const createDirectSetup = (asyncTryGetSigner: boolean) => {
    const timelockOwnerA = '0x3636363636363636363636363636363636363637';
    const timelockOwnerB = '0x3737373737373737373737373737373737373738';
    const proposerIca = '0x3838383838383838383838383838383838383839';
    const destinationRouterAddress =
      '0x3939393939393939393939393939393939393940';
    const originRouterAddress = '0x4040404040404040404040404040404040404041';

    const ownerByTarget: Record<string, string> = {
      '0x1111111111111111111111111111111111111111': timelockOwnerA,
      '0x4444444444444444444444444444444444444444': timelockOwnerB,
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

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (
          (filter.address === timelockOwnerA ||
            filter.address === timelockOwnerB) &&
          filter.topics?.[0] === 'RoleGranted'
        ) {
          return [{ topics: [], data: '0x' }];
        }
        return [];
      }),
    };

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
        tryGetSigner: asyncTryGetSigner
          ? async (chainName: string) => {
              if (chainName === CHAIN) return {};
              originSignerProbeCalls += 1;
              return DATAVIEW_CONSTRUCTOR_PROBE;
            }
          : (chainName: string) => {
              if (chainName === CHAIN) return {};
              originSignerProbeCalls += 1;
              return DATAVIEW_CONSTRUCTOR_PROBE;
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

    return {
      context,
      provider,
      getOriginSignerProbeCalls: () => originSignerProbeCalls,
      getOriginSignerAddressLookups: () => originSignerAddressLookups,
      restore: () => {
        ownableStub.restore();
        safeStub.restore();
        timelockStub.restore();
        icaRouterStub.restore();
      },
    };
  };

  const createEventDerivedSetup = (asyncTryGetSigner: boolean) => {
    const timelockOwnerA = '0x4141414141414141414141414141414141414142';
    const timelockOwnerB = '0x4242424242424242424242424242424242424243';
    const proposerIca = '0x4343434343434343434343434343434343434344';
    const destinationRouterAddress =
      '0x4444444444444444444444444444444444444445';
    const originOwner = SIGNER.toLowerCase();
    const originOwnerBytes32 =
      `0x000000000000000000000000${originOwner.slice(2)}` as const;
    const originRouterBytes32 =
      '0x0000000000000000000000004545454545454545454545454545454545454546';

    const ownerByTarget: Record<string, string> = {
      '0x1111111111111111111111111111111111111111': timelockOwnerA,
      '0x4444444444444444444444444444444444444444': timelockOwnerB,
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
              InterchainAccountCreated: (_accountAddress: string) => ({
                address: destinationRouterAddress,
              }),
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

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        const normalizedAddress =
          typeof filter.address === 'string'
            ? filter.address.toLowerCase()
            : filter.address;
        if (
          (normalizedAddress === timelockOwnerA.toLowerCase() ||
            normalizedAddress === timelockOwnerB.toLowerCase()) &&
          filter.topics?.[0] === 'RoleGranted'
        ) {
          return [{ topics: [], data: normalizedAddress }];
        }
        if (normalizedAddress === destinationRouterAddress.toLowerCase()) {
          return [{ topics: [], data: '0x' }];
        }
        return [];
      }),
    };

    let chainNameCalls = 0;
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
        getChainName: (domainId: number) => {
          chainNameCalls += 1;
          if (domainId === 31347) return 'anvil3';
          throw new Error(`unknown domain ${domainId}`);
        },
        tryGetSigner: asyncTryGetSigner
          ? async (chainName: string) => {
              if (chainName === CHAIN) return {};
              originSignerProbeCalls += 1;
              return DATAVIEW_CONSTRUCTOR_PROBE;
            }
          : (chainName: string) => {
              if (chainName === CHAIN) return {};
              originSignerProbeCalls += 1;
              return DATAVIEW_CONSTRUCTOR_PROBE;
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

    return {
      context,
      provider,
      getOriginSignerProbeCalls: () => originSignerProbeCalls,
      getOriginSignerAddressLookups: () => originSignerAddressLookups,
      getChainNameCalls: () => chainNameCalls,
      restore: () => {
        ownableStub.restore();
        safeStub.restore();
        timelockStub.restore();
        icaRouterStub.restore();
      },
    };
  };

  it('caches dataview-constructor-object origin signer probes across timelock ICA inferences', async () => {
    const setup = createDirectSetup(false);
    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x4444444444444444444444444444444444444444' } as any,
        ],
        context: setup.context,
      });
      expectTimelockJsonRpcBatches(batches);
      expect(setup.getOriginSignerProbeCalls()).to.equal(1);
      expect(setup.getOriginSignerAddressLookups()).to.equal(1);
      expect(setup.provider.getLogs.callCount).to.equal(5);
    } finally {
      setup.restore();
    }
  });

  it('caches async dataview-constructor-object origin signer probes across timelock ICA inferences', async () => {
    const setup = createDirectSetup(true);
    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x4444444444444444444444444444444444444444' } as any,
        ],
        context: setup.context,
      });
      expectTimelockJsonRpcBatches(batches);
      expect(setup.getOriginSignerProbeCalls()).to.equal(1);
      expect(setup.getOriginSignerAddressLookups()).to.equal(1);
      expect(setup.provider.getLogs.callCount).to.equal(5);
    } finally {
      setup.restore();
    }
  });

  it('caches event-derived dataview-constructor-object origin signer probes across timelock ICA inferences', async () => {
    const setup = createEventDerivedSetup(false);
    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x4444444444444444444444444444444444444444' } as any,
        ],
        context: setup.context,
      });
      expectTimelockJsonRpcBatches(batches);
      expect(setup.getOriginSignerProbeCalls()).to.equal(1);
      expect(setup.getOriginSignerAddressLookups()).to.equal(1);
      expect(setup.getChainNameCalls()).to.equal(1);
      expect(setup.provider.getLogs.callCount).to.equal(5);
    } finally {
      setup.restore();
    }
  });

  it('caches event-derived async dataview-constructor-object origin signer probes across timelock ICA inferences', async () => {
    const setup = createEventDerivedSetup(true);
    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
          { ...TX, to: '0x4444444444444444444444444444444444444444' } as any,
        ],
        context: setup.context,
      });
      expectTimelockJsonRpcBatches(batches);
      expect(setup.getOriginSignerProbeCalls()).to.equal(1);
      expect(setup.getOriginSignerAddressLookups()).to.equal(1);
      expect(setup.getChainNameCalls()).to.equal(1);
      expect(setup.provider.getLogs.callCount).to.equal(5);
    } finally {
      setup.restore();
    }
  });
});
