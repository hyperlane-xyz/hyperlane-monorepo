import { expect } from 'chai';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { StarknetMailboxArtifactManager } from './mailbox-artifact-manager.js';

describe('StarknetMailboxArtifactManager', () => {
  const chainMetadata = {
    name: 'starknet-test',
    chainId: 1234,
    domainId: 1234,
    protocol: 'starknet',
    rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
    nativeToken: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
      denom: 'ETH',
    },
  } as any;

  it('creates mailbox and applies owner/hook configuration', async () => {
    const manager = new StarknetMailboxArtifactManager(chainMetadata);
    const calls = {
      defaultHook: 0,
      requiredHook: 0,
      owner: 0,
    };

    const signer = {
      getSignerAddress: () => '0x01',
      createMailbox: async () => ({ mailboxAddress: '0xabc' }),
      setDefaultHook: async () => {
        calls.defaultHook += 1;
      },
      setRequiredHook: async () => {
        calls.requiredHook += 1;
      },
      setMailboxOwner: async () => {
        calls.owner += 1;
      },
    };

    const writer = manager.createWriter('mailbox', signer as any) as any;
    writer.read = async () => ({
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: '0x02',
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x10' },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x20' },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x30' },
        },
      },
      deployed: { address: '0xabc', domainId: 1234 },
    });

    const [deployed] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: {
        owner: '0x02',
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x10' },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x20' },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x30' },
        },
      },
    });

    expect(deployed.deployed.address).to.equal('0xabc');
    expect(calls).to.deep.equal({
      defaultHook: 1,
      requiredHook: 1,
      owner: 1,
    });
  });

  it('creates mailbox update transactions for changed fields', async () => {
    const manager = new StarknetMailboxArtifactManager(chainMetadata);
    const signer = {
      getSignerAddress: () => '0x01',
      getSetDefaultIsmTransaction: async () => ({
        kind: 'invoke',
        contractAddress: '0xabc',
        entrypoint: 'set_default_ism',
        calldata: [],
      }),
      getSetDefaultHookTransaction: async () => ({
        kind: 'invoke',
        contractAddress: '0xabc',
        entrypoint: 'set_default_hook',
        calldata: [],
      }),
      getSetRequiredHookTransaction: async () => ({
        kind: 'invoke',
        contractAddress: '0xabc',
        entrypoint: 'set_required_hook',
        calldata: [],
      }),
      getSetMailboxOwnerTransaction: async () => ({
        kind: 'invoke',
        contractAddress: '0xabc',
        entrypoint: 'transfer_ownership',
        calldata: [],
      }),
    };

    const writer = manager.createWriter('mailbox', signer as any) as any;
    writer.read = async () => ({
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: '0x01',
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x10' },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x20' },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x30' },
        },
      },
      deployed: { address: '0xabc', domainId: 1234 },
    });

    const txs = await writer.update({
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: '0x02',
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x11' },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x21' },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x31' },
        },
      },
      deployed: { address: '0xabc', domainId: 1234 },
    });

    expect(txs).to.have.length(4);
    expect(txs.map((tx) => tx.annotation)).to.deep.equal([
      'Updating mailbox default ISM',
      'Updating mailbox default hook',
      'Updating mailbox required hook',
      'Updating mailbox owner',
    ]);
  });
});
