import { fileURLToPath } from 'url';

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
import {
  getCachedRuntimeObjectValuesByLabel,
  getCleanRuntimeProbeLabels,
  getKnownObjectLikeProbeLabelsFromOtherTests,
} from './inference.runtime-globals.js';

describe('resolveSubmitterBatchesForTransactions global object probes', () => {
  const CHAIN = 'anvil2';
  const SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  const thisFilePath = fileURLToPath(import.meta.url);
  const knownLabelsFromOtherFiles =
    getKnownObjectLikeProbeLabelsFromOtherTests(thisFilePath);

  const baselineObjectLabels = getCleanRuntimeProbeLabels().objectLabels;

  const runtimeObjectValueByLabel = getCachedRuntimeObjectValuesByLabel();

  const PROBE_CASES = baselineObjectLabels
    .map((label) => ({
      label,
      name: label.slice(0, -'-object'.length),
      value: runtimeObjectValueByLabel.get(label) ?? { __label: label },
    }))
    .filter(({ label }) => !knownLabelsFromOtherFiles.has(label));

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

  const createDirectSetup = (
    probeValue: object,
    asyncTryGetSigner: boolean,
  ) => {
    const timelockOwnerA = '0x1212121212121212121212121212121212121213';
    const timelockOwnerB = '0x1313131313131313131313131313131313131314';
    const proposerIca = '0x1414141414141414141414141414141414141415';
    const destinationRouterAddress =
      '0x1515151515151515151515151515151515151516';
    const originRouterAddress = '0x1616161616161616161616161616161616161617';

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
              return probeValue;
            }
          : (chainName: string) => {
              if (chainName === CHAIN) return {};
              originSignerProbeCalls += 1;
              return probeValue;
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

  const createEventDerivedSetup = (
    probeValue: object,
    asyncTryGetSigner: boolean,
  ) => {
    const timelockOwnerA = '0x1717171717171717171717171717171717171718';
    const timelockOwnerB = '0x1818181818181818181818181818181818181819';
    const proposerIca = '0x1919191919191919191919191919191919191920';
    const destinationRouterAddress =
      '0x2020202020202020202020202020202020202021';
    const originOwner = SIGNER.toLowerCase();
    const originOwnerBytes32 =
      `0x000000000000000000000000${originOwner.slice(2)}` as const;
    const originRouterBytes32 =
      '0x0000000000000000000000002121212121212121212121212121212121212122';

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
              return probeValue;
            }
          : (chainName: string) => {
              if (chainName === CHAIN) return {};
              originSignerProbeCalls += 1;
              return probeValue;
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

  PROBE_CASES.forEach(({ label, name, value }) => {
    it(`caches ${label} origin signer probes across timelock ICA inferences`, async () => {
      const setup = createDirectSetup(value, false);
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
        expect(setup.getOriginSignerProbeCalls(), name).to.equal(1);
        expect(setup.getOriginSignerAddressLookups(), name).to.equal(1);
        expect(setup.provider.getLogs.callCount, name).to.be.greaterThanOrEqual(
          4,
        );
      } finally {
        setup.restore();
      }
    });

    it(`caches async ${label} origin signer probes across timelock ICA inferences`, async () => {
      const setup = createDirectSetup(value, true);
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
        expect(setup.getOriginSignerProbeCalls(), name).to.equal(1);
        expect(setup.getOriginSignerAddressLookups(), name).to.equal(1);
        expect(setup.provider.getLogs.callCount, name).to.be.greaterThanOrEqual(
          4,
        );
      } finally {
        setup.restore();
      }
    });

    it(`caches event-derived ${label} origin signer probes across timelock ICA inferences`, async () => {
      const setup = createEventDerivedSetup(value, false);
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
        expect(setup.getOriginSignerProbeCalls(), name).to.equal(1);
        expect(setup.getOriginSignerAddressLookups(), name).to.equal(1);
        expect(setup.getChainNameCalls(), name).to.equal(1);
        expect(setup.provider.getLogs.callCount, name).to.be.greaterThanOrEqual(
          5,
        );
      } finally {
        setup.restore();
      }
    });

    it(`caches event-derived async ${label} origin signer probes across timelock ICA inferences`, async () => {
      const setup = createEventDerivedSetup(value, true);
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
        expect(setup.getOriginSignerProbeCalls(), name).to.equal(1);
        expect(setup.getOriginSignerAddressLookups(), name).to.equal(1);
        expect(setup.getChainNameCalls(), name).to.equal(1);
        expect(setup.provider.getLogs.callCount, name).to.be.greaterThanOrEqual(
          5,
        );
      } finally {
        setup.restore();
      }
    });
  });
});
