import { expect } from 'chai';
import { describe, it } from 'mocha';

import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { SvmHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { SvmIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { SvmWarpArtifactManager } from '../warp/warp-artifact-manager.js';
import { SvmProtocolProvider } from '../clients/protocol.js';

const FAKE_METADATA: ChainMetadataForAltVM = {
  name: 'solanamainnet',
  protocol: ProtocolType.Sealevel,
  domainId: 1399811149,
  chainId: '1399811149',
  rpcUrls: [{ http: 'http://localhost:8899' }],
};

const FAKE_MAILBOX = 'E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi';

describe('SvmProtocolProvider', () => {
  const provider = new SvmProtocolProvider();

  describe('createHookArtifactManager', () => {
    it('returns SvmHookArtifactManager with mailbox from context', () => {
      const manager = provider.createHookArtifactManager(FAKE_METADATA, {
        mailbox: FAKE_MAILBOX,
      });
      expect(manager).to.be.instanceOf(SvmHookArtifactManager);
    });

    it('returns SvmHookArtifactManager without mailbox when no context', () => {
      const manager = provider.createHookArtifactManager(FAKE_METADATA);
      expect(manager).to.be.instanceOf(SvmHookArtifactManager);
    });

    it('returns SvmHookArtifactManager when context has no mailbox', () => {
      const manager = provider.createHookArtifactManager(FAKE_METADATA, {});
      expect(manager).to.be.instanceOf(SvmHookArtifactManager);
    });
  });

  describe('createIsmArtifactManager', () => {
    it('returns SvmIsmArtifactManager', () => {
      const manager = provider.createIsmArtifactManager(FAKE_METADATA);
      expect(manager).to.be.instanceOf(SvmIsmArtifactManager);
    });
  });

  describe('createWarpArtifactManager', () => {
    it('returns SvmWarpArtifactManager', () => {
      const manager = provider.createWarpArtifactManager(FAKE_METADATA);
      expect(manager).to.be.instanceOf(SvmWarpArtifactManager);
    });
  });

  describe('getRpcUrls validation', () => {
    it('throws when no rpcUrls', () => {
      const noRpc = { ...FAKE_METADATA, rpcUrls: [] };
      expect(() => provider.createIsmArtifactManager(noRpc)).to.throw(
        'At least one RPC URL is required',
      );
    });

    it('throws when rpcUrls is undefined', () => {
      const noRpc = { ...FAKE_METADATA, rpcUrls: undefined };
      expect(() => provider.createIsmArtifactManager(noRpc)).to.throw(
        'At least one RPC URL is required',
      );
    });
  });
});
