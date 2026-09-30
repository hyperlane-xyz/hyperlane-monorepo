import { expect } from 'chai';

import * as AltVM from './altvm.js';
import { ArtifactState } from './artifact.js';
import { ChainLookup } from './chain.js';
import {
  HookArtifactConfig,
  HookConfig,
  HookType,
  UnsupportedHookArtifactTypeError,
  altVmHookTypeToProviderHookType,
  assertNoUnsupportedIgpFields,
  hookArtifactToDerivedConfig,
  hookConfigToArtifact,
  isDirectHookArtifactConfig,
  isMutableHookConfig,
  mergeHookArtifacts,
  shouldDeployNewHook,
  throwUnsupportedHookType,
} from './hook.js';
import { ProtocolType } from './protocolType.js';

const chainLookup: ChainLookup = {
  getChainMetadata: () => {
    throw new Error('not needed');
  },
  getDomainId: (chain) => (chain === 'ethereum' ? 1 : null),
  getChainName: (domainId: number) => (domainId === 1 ? 'ethereum' : null),
  getKnownChainNames: () => ['ethereum'],
};

describe('AltVM hook type conversion', () => {
  it('maps every AltVM hook type to the provider SDK catalog', () => {
    for (const hookType of Object.values(AltVM.HookType)) {
      expect(altVmHookTypeToProviderHookType(hookType)).to.equal(hookType);
    }
  });
});

describe('isMutableHookConfig', () => {
  it('distinguishes mutable from immutable hook types', () => {
    expect(
      isMutableHookConfig({
        type: HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        oracleKey: '0xoracle',
        overhead: {},
        oracleConfig: {},
      }),
    ).to.equal(true);
    expect(isMutableHookConfig({ type: HookType.MERKLE_TREE })).to.equal(false);
  });
});

describe('isDirectHookArtifactConfig', () => {
  it('distinguishes direct hooks from nested hook artifacts', () => {
    const nestedHooks: HookArtifactConfig[] = [
      { type: HookType.AGGREGATION, hooks: [] },
      { type: HookType.ROUTING, owner: '0xowner', domains: {} },
      {
        type: HookType.FALLBACK_ROUTING,
        owner: '0xowner',
        domains: {},
        fallback: {
          artifactState: ArtifactState.NEW,
          config: { type: HookType.MERKLE_TREE },
        },
      },
      {
        type: HookType.AMOUNT_ROUTING,
        threshold: 1,
        lowerHook: {
          artifactState: ArtifactState.NEW,
          config: { type: HookType.MERKLE_TREE },
        },
        upperHook: {
          artifactState: ArtifactState.NEW,
          config: { type: HookType.MERKLE_TREE },
        },
      },
      {
        type: HookType.ARB_L2_TO_L1,
        arbSys: '0xarbSys',
        destinationDomain: 1,
        childHook: {
          artifactState: ArtifactState.NEW,
          config: { type: HookType.MERKLE_TREE },
        },
      },
    ];

    expect(isDirectHookArtifactConfig({ type: HookType.MERKLE_TREE })).to.equal(
      true,
    );
    expect(
      nestedHooks.every((hook) => !isDirectHookArtifactConfig(hook)),
    ).to.equal(true);
  });
});

describe('assertNoUnsupportedIgpFields', () => {
  it('accepts basic IGP config fields', () => {
    expect(() => {
      assertNoUnsupportedIgpFields({}, ProtocolType.CosmosNative);
    }).not.to.throw();
  });

  it('rejects unsupported IGP fields with protocol context', () => {
    expect(() => {
      assertNoUnsupportedIgpFields(
        { tokenOracleConfig: {} },
        ProtocolType.Sealevel,
      );
    }).to.throw('tokenOracleConfig is not supported on sealevel IGP hooks');
  });
});

describe('hook protocolFee support', () => {
  it('converts protocolFee hook config into artifact config', () => {
    const config: HookConfig = {
      type: HookType.PROTOCOL_FEE,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      maxProtocolFee: '100',
      protocolFee: '10',
    };

    const artifact = hookConfigToArtifact(config, chainLookup);
    expect(artifact).to.deep.equal({
      artifactState: ArtifactState.NEW,
      config,
    });
  });

  it('keeps protocolFee hook mutable when maxProtocolFee unchanged', () => {
    const actual = {
      type: HookType.PROTOCOL_FEE,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      maxProtocolFee: '100',
      protocolFee: '10',
    } as const;
    const expected = {
      type: HookType.PROTOCOL_FEE,
      owner: '0xowner2',
      beneficiary: '0xbeneficiary2',
      maxProtocolFee: '100',
      protocolFee: '20',
    } as const;

    expect(shouldDeployNewHook(actual, expected)).to.equal(false);
  });

  it('requires redeploy when protocolFee maxProtocolFee changes', () => {
    const actual = {
      type: HookType.PROTOCOL_FEE,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      maxProtocolFee: '100',
      protocolFee: '10',
    } as const;
    const expected = {
      type: HookType.PROTOCOL_FEE,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      maxProtocolFee: '200',
      protocolFee: '10',
    } as const;

    expect(shouldDeployNewHook(actual, expected)).to.equal(true);
  });

  it('fails closed when protocolFee max is unreadable', () => {
    const actual = {
      type: HookType.PROTOCOL_FEE,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      maxProtocolFee: '10',
      protocolFee: '10',
    } as const;
    Object.defineProperty(actual, '__maxProtocolFeeUnknown', {
      value: true,
    });
    const expected = {
      type: HookType.PROTOCOL_FEE,
      owner: '0xowner2',
      beneficiary: '0xbeneficiary2',
      maxProtocolFee: '200',
      protocolFee: '20',
    } as const;

    expect(() => shouldDeployNewHook(actual, expected)).to.throw(
      'readable maxProtocolFee',
    );
  });

  it('derives protocolFee hook config with address', () => {
    const derived = hookArtifactToDerivedConfig(
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: HookType.PROTOCOL_FEE,
          owner: '0xowner',
          beneficiary: '0xbeneficiary',
          maxProtocolFee: '100',
          protocolFee: '10',
        },
        deployed: { address: '0xabc' },
      },
      chainLookup,
    );

    expect(derived).to.deep.equal({
      type: HookType.PROTOCOL_FEE,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      maxProtocolFee: '100',
      protocolFee: '10',
      address: '0xabc',
    });
  });

  it('derives unknownHook config with address', () => {
    const derived = hookArtifactToDerivedConfig(
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'unknownHook',
        },
        deployed: { address: '0xdef' },
      },
      chainLookup,
    );

    expect(derived).to.deep.equal({
      type: 'unknownHook',
      address: '0xdef',
    });
  });

  it('does not redeploy unknownHook when type is unchanged', () => {
    const actual = {
      type: 'unknownHook',
    } as const;
    const expected = {
      type: 'unknownHook',
    } as const;

    expect(shouldDeployNewHook(actual, expected)).to.equal(false);
  });

  it('keeps a mutable pausable hook deployed', () => {
    const current = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: HookType.PAUSABLE,
        owner: '0xcurrentOwner',
        paused: false,
      },
      deployed: { address: '0xhook' },
    } as const;
    const expected = {
      artifactState: ArtifactState.NEW,
      config: {
        type: HookType.PAUSABLE,
        owner: '0xexpectedOwner',
        paused: true,
      },
    } as const;

    expect(mergeHookArtifacts(current, expected)).to.deep.equal({
      artifactState: ArtifactState.DEPLOYED,
      config: expected.config,
      deployed: current.deployed,
    });
  });

  it('keeps a rate-limited hook deployed when only capacity changes', () => {
    expect(
      shouldDeployNewHook(
        {
          type: HookType.RATE_LIMITED,
          owner: '0xowner',
          maxCapacity: '4',
          duration: 2n,
        },
        {
          type: HookType.RATE_LIMITED,
          owner: '0xowner',
          maxCapacity: '6',
          duration: 2n,
        },
      ),
    ).to.equal(false);
  });

  it('redeploys a rate-limited hook when duration changes', () => {
    expect(
      shouldDeployNewHook(
        {
          type: HookType.RATE_LIMITED,
          owner: '0xowner',
          maxCapacity: '6',
          duration: 2n,
        },
        {
          type: HookType.RATE_LIMITED,
          owner: '0xowner',
          maxCapacity: '6',
          duration: 3n,
        },
      ),
    ).to.equal(true);
  });

  it('redeploys a read-only hybrid hook when its config changes', () => {
    expect(
      shouldDeployNewHook(
        {
          type: HookType.DELAYED_FLOW_ROUTER,
          owner: '0xowner',
          warpRouter: '0xrouter',
          thresholdBps: 100,
          maxDelay: 10,
          duration: 20n,
          remoteIsms: { '1': '0xism1' },
        },
        {
          type: HookType.DELAYED_FLOW_ROUTER,
          owner: '0xnewOwner',
          thresholdBps: 100,
          maxDelay: 10,
          duration: 20n,
          remoteIsms: { '1': '0xism2' },
        },
      ),
    ).to.equal(true);
  });

  it('throws clear errors for unsupported hook artifact types', () => {
    const hookType = AltVM.HookType.PROTOCOL_FEE;

    expect(() => throwUnsupportedHookType(hookType, ProtocolType.Aleo))
      .to.throw(
        UnsupportedHookArtifactTypeError,
        `Unsupported hook artifact type ${hookType} for protocol ${ProtocolType.Aleo}`,
      )
      .and.include({
        hookType,
        protocol: ProtocolType.Aleo,
      });
  });

  it('includes hook type in hookConfigToArtifact errors', () => {
    expect(() =>
      hookConfigToArtifact(
        { type: 'futureHook' } as unknown as HookConfig,
        chainLookup,
      ),
    ).to.throw(/Unhandled hook type in hookConfigToArtifact: futureHook/);
  });

  it('includes hook type in shouldDeployNewHook errors', () => {
    expect(() =>
      shouldDeployNewHook(
        { type: 'futureHook' } as never,
        { type: 'futureHook' } as never,
      ),
    ).to.throw(/Unhandled hook type in shouldDeployNewHook: futureHook/);
  });

  it('includes hook type in hookArtifactToDerivedConfig errors', () => {
    expect(() =>
      hookArtifactToDerivedConfig(
        {
          artifactState: ArtifactState.DEPLOYED,
          config: { type: 'futureHook' } as never,
          deployed: { address: '0xabc' },
        },
        chainLookup,
      ),
    ).to.throw(
      /Unhandled hook type in hookArtifactToDerivedConfig: futureHook/,
    );
  });
});

describe('hook interchainGasPaymaster support', () => {
  const oracleData = {
    gasPrice: '1',
    tokenExchangeRate: '1000000000000000000',
  };
  const artifactOracleData = oracleData;

  it('preserves IGP metadata through Config → Artifact', () => {
    const config: HookConfig = {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      oracleKey: '0xoracleKey',
      overhead: { ethereum: 50000 },
      oracleConfig: { ethereum: oracleData },
      contractVersion: '1.0.0',
      quoteSigners: ['0xaa', '0xbb'],
      tokenOracleConfig: {
        '0x0000000000000000000000000000000000000001': {
          ethereum: oracleData,
        },
      },
    };

    const artifact = hookConfigToArtifact(config, chainLookup);
    expect(artifact.config).to.deep.equal({
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      oracleKey: '0xoracleKey',
      overhead: { 1: 50000 },
      oracleConfig: { 1: artifactOracleData },
      contractVersion: '1.0.0',
      quoteSigners: ['0xaa', '0xbb'],
      tokenOracleConfig: {
        '0x0000000000000000000000000000000000000001': {
          1: artifactOracleData,
        },
      },
    });
  });

  it('passes through undefined optional IGP metadata', () => {
    const config: HookConfig = {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      oracleKey: '0xoracleKey',
      overhead: { ethereum: 50000 },
      oracleConfig: { ethereum: oracleData },
    };

    const artifact = hookConfigToArtifact(config, chainLookup);
    expect(artifact.config).to.have.property('contractVersion', undefined);
    expect(artifact.config).to.have.property('quoteSigners', undefined);
  });

  it('preserves IGP metadata through Artifact → DerivedConfig', () => {
    const derived = hookArtifactToDerivedConfig(
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: '0xowner',
          beneficiary: '0xbeneficiary',
          oracleKey: '0xoracleKey',
          overhead: { 1: 50000 },
          oracleConfig: { 1: artifactOracleData },
          contractVersion: '1.0.0',
          quoteSigners: ['0xaa'],
          tokenOracleConfig: {
            '0x0000000000000000000000000000000000000001': {
              1: artifactOracleData,
            },
          },
        },
        deployed: { address: '0xigpAddress' },
      },
      chainLookup,
    );

    expect(derived).to.deep.equal({
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      oracleKey: '0xoracleKey',
      overhead: { ethereum: 50000 },
      oracleConfig: { ethereum: oracleData },
      contractVersion: '1.0.0',
      quoteSigners: ['0xaa'],
      tokenOracleConfig: {
        '0x0000000000000000000000000000000000000001': {
          ethereum: oracleData,
        },
      },
      address: '0xigpAddress',
    });
  });

  it('round-trips Config → Artifact → DerivedConfig with all fields preserved', () => {
    const config: HookConfig = {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      oracleKey: '0xoracleKey',
      overhead: { ethereum: 50000 },
      oracleConfig: { ethereum: oracleData },
      contractVersion: '1.0.0',
      quoteSigners: ['0xaa', '0xbb'],
    };

    const artifact = hookConfigToArtifact(config, chainLookup);
    const derived = hookArtifactToDerivedConfig(
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: { address: '0xigpAddress' },
      },
      chainLookup,
    );

    expect(derived).to.deep.include({
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      contractVersion: '1.0.0',
    });
    expect(derived)
      .to.have.property('quoteSigners')
      .that.deep.equals(['0xaa', '0xbb']);
  });
});
