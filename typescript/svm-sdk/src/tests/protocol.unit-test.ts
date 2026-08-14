import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
  AltVMImpersonatedSubmitter,
  AltVMJsonRpcSubmitter,
  type ChainMetadataForAltVM,
  type ImpersonatedAccountSubmitterConfig,
  type JsonRpcSubmitterConfig,
  ProtocolType,
  SubmitterType,
} from '@hyperlane-xyz/provider-sdk';
import { assert } from '@hyperlane-xyz/utils';

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

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

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

  describe('createSubmitter', () => {
    interface Case {
      name: string;
      config: JsonRpcSubmitterConfig | ImpersonatedAccountSubmitterConfig;
      expectedInstance:
        | typeof AltVMJsonRpcSubmitter
        | typeof AltVMImpersonatedSubmitter;
      expectedSubmitterType: string;
    }

    const cases: Case[] = [
      {
        name: 'jsonRpc',
        config: {
          type: SubmitterType.JsonRpc,
          chain: FAKE_METADATA.name,
          privateKey: TEST_PRIVATE_KEY,
        },
        expectedInstance: AltVMJsonRpcSubmitter,
        // Released label is 'jsonRPC' (capital RPC), distinct from the config
        // discriminant SubmitterType.JsonRpc; preserved for external consumers.
        expectedSubmitterType: 'jsonRPC',
      },
      {
        // Keyless: the impersonated submitter pays fees from a fixed fork
        // account, so no private key is supplied. userAddress scopes which
        // account the Sealevel signer will impersonate.
        name: 'impersonatedAccount',
        config: {
          type: SubmitterType.ImpersonatedAccount,
          chain: FAKE_METADATA.name,
          userAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9nWLyBpb',
        },
        expectedInstance: AltVMImpersonatedSubmitter,
        expectedSubmitterType: SubmitterType.ImpersonatedAccount,
      },
    ];

    for (const c of cases) {
      it(`dispatches ${c.name} to the matching submitter`, async () => {
        const submitter = await provider.createSubmitter(
          FAKE_METADATA,
          c.config,
        );

        expect(submitter).to.be.instanceOf(c.expectedInstance);
        // txSubmitterType lives on the concrete submitter, not the
        // ITransactionSubmitter interface — narrow before reading it.
        assert(
          submitter instanceof AltVMJsonRpcSubmitter ||
            submitter instanceof AltVMImpersonatedSubmitter,
          'expected an AltVM submitter instance',
        );
        expect(submitter.txSubmitterType).to.equal(c.expectedSubmitterType);
      });
    }

    it('throws for the file submitter type', async () => {
      try {
        await provider.createSubmitter(FAKE_METADATA, {
          type: SubmitterType.File,
          chain: FAKE_METADATA.name,
          filepath: '/tmp/does-not-matter.yaml',
        });
        expect.fail('expected createSubmitter to throw for the file submitter');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).to.include(
          'File submission is a Node/CLI-layer concern',
        );
      }
    });
  });
});
