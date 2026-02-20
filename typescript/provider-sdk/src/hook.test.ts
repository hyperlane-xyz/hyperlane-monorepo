import { expect } from 'chai';

import { ArtifactState } from './artifact.js';
import {
  HookConfig,
  createUnsupportedHookReader,
  createUnsupportedHookWriter,
  hookArtifactToDerivedConfig,
  hookConfigToArtifact,
  shouldDeployNewHook,
} from './hook.js';

const chainLookup = {
  getDomainId: (chain: string) => (chain === 'ethereum' ? 1 : null),
  getChainName: (domainId: number) => (domainId === 1 ? 'ethereum' : null),
} as any;

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

  it('creates unsupported hook reader/writer helpers with clear errors', async () => {
    const reader = createUnsupportedHookReader('protocolFee', 'Aleo');
    const writer = createUnsupportedHookWriter('protocolFee', 'Aleo');

    let readerError: unknown;
    try {
      await reader.read('0x1');
    } catch (error) {
      readerError = error;
    }

    let writerError: unknown;
    try {
      await writer.create({} as any);
    } catch (error) {
      writerError = error;
    }

    expect(String(readerError)).to.include(
      'protocolFee hook type is unsupported on Aleo',
    );
    expect(String(writerError)).to.include(
      'protocolFee hook type is unsupported on Aleo',
    );
  });
});
