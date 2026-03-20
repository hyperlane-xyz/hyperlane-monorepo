import { expect } from 'chai';

import { ArtifactState } from './artifact.js';
import { ChainLookup } from './chain.js';
import {
  HookConfig,
  hookArtifactToDerivedConfig,
  hookConfigToArtifact,
  shouldDeployNewHook,
  throwUnsupportedHookType,
} from './hook.js';

const chainLookup: ChainLookup = {
  getChainMetadata: () => {
    throw new Error('not needed');
  },
  getDomainId: (chain) => (chain === 'ethereum' ? 1 : null),
  getChainName: (domainId: number) => (domainId === 1 ? 'ethereum' : null),
  getKnownChainNames: () => ['ethereum'],
};

describe('hook protocolFee support', () => {
  it('converts protocolFee hook config into artifact config', () => {
    const config: HookConfig = {
      type: 'protocolFee',
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
      type: 'protocolFee',
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      maxProtocolFee: '100',
      protocolFee: '10',
    } as const;
    const expected = {
      type: 'protocolFee',
      owner: '0xowner2',
      beneficiary: '0xbeneficiary2',
      maxProtocolFee: '100',
      protocolFee: '20',
    } as const;

    expect(shouldDeployNewHook(actual, expected)).to.equal(false);
  });

  it('requires redeploy when protocolFee maxProtocolFee changes', () => {
    const actual = {
      type: 'protocolFee',
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      maxProtocolFee: '100',
      protocolFee: '10',
    } as const;
    const expected = {
      type: 'protocolFee',
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      maxProtocolFee: '200',
      protocolFee: '10',
    } as const;

    expect(shouldDeployNewHook(actual, expected)).to.equal(true);
  });

  it('fails closed when protocolFee max is unreadable', () => {
    const actual = {
      type: 'protocolFee',
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      maxProtocolFee: '10',
      protocolFee: '10',
    } as const;
    Object.defineProperty(actual, '__maxProtocolFeeUnknown', {
      value: true,
    });
    const expected = {
      type: 'protocolFee',
      owner: '0xowner2',
      beneficiary: '0xbeneficiary2',
      maxProtocolFee: '200',
      protocolFee: '20',
    } as const;

    let error: unknown;
    try {
      shouldDeployNewHook(actual, expected);
    } catch (caughtError) {
      error = caughtError;
    }

    expect(String(error)).to.include('readable maxProtocolFee');
  });

  it('derives protocolFee hook config with address', () => {
    const derived = hookArtifactToDerivedConfig(
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'protocolFee',
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
      type: 'protocolFee',
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

  it('throws clear errors for unsupported hook artifact types', () => {
    expect(() => throwUnsupportedHookType('protocolFee', 'Aleo')).to.throw(
      'Unsupported hook artifact type protocolFee for protocol Aleo',
    );
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
