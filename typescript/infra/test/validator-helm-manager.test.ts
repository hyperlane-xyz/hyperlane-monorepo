import { expect } from 'chai';

import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts.js';
import { Role } from '../src/roles.js';
import type { RootAgentConfig } from '../src/config/agent/agent.js';
import { CheckpointSyncerType } from '../src/config/agent/validator.js';

import { ValidatorHelmManager } from '../src/agents/index.js';

describe('ValidatorHelmManager', () => {
  it('renders validator reorg period into the origin chain config', async () => {
    const config: RootAgentConfig = {
      runEnv: 'testnet4',
      namespace: 'test',
      context: Contexts.FastPath,
      rolesWithKeys: [Role.Validator],
      environmentChainNames: ['sepolia'],
      contextChainNames: {
        [Role.Validator]: ['sepolia'],
        [Role.Relayer]: [],
        [Role.Scraper]: [],
      },
      validators: {
        rpcConsensusType: RpcConsensusType.Fallback,
        docker: {
          repo: 'ghcr.io/hyperlane-xyz/hyperlane-agent',
          tag: 'test',
        },
        chains: {
          sepolia: {
            interval: 1,
            reorgPeriod: 1,
            validators: [
              {
                name: 'fastpath-test-validator-0',
                address: '',
                checkpointSyncer: {
                  type: CheckpointSyncerType.LocalStorage,
                  path: '/tmp/fastpath-test-validator-0',
                },
              },
            ],
          },
        },
      },
    };

    const manager = new ValidatorHelmManager(config, 'sepolia');
    const values = await manager.helmValues();

    expect(values.hyperlane.chains).to.have.lengthOf(1);
    expect(values.hyperlane.chains[0].name).to.equal('sepolia');
    expect(values.hyperlane.chains[0].blocks?.reorgPeriod).to.equal(1);
    // Set from the validator's own chain config, independent of any relayer config
    // (there is none in this RootAgentConfig).
    expect(values.hyperlane.chains[0].index?.interval).to.equal(1);
    expect(values.hyperlane.validator?.configs).to.have.lengthOf(1);
    expect(values.hyperlane.validator?.configs?.[0].interval).to.equal(1);
  });

  it('filters blocked RPCs from the validator additional quorum pool', async () => {
    const config: RootAgentConfig = {
      runEnv: 'mainnet3',
      namespace: 'test',
      context: Contexts.Hyperlane,
      rolesWithKeys: [Role.Validator],
      environmentChainNames: ['arbitrum'],
      contextChainNames: {
        [Role.Validator]: ['arbitrum'],
        [Role.Relayer]: [],
        [Role.Scraper]: [],
      },
      validators: {
        rpcConsensusType: RpcConsensusType.Quorum,
        docker: {
          repo: 'ghcr.io/hyperlane-xyz/hyperlane-agent',
          tag: 'test',
        },
        chains: {
          arbitrum: {
            interval: 1,
            reorgPeriod: 1,
            quorumVerificationEnabled: true,
            validators: [
              {
                name: 'arbitrum-test-validator-0',
                address: '',
                checkpointSyncer: {
                  type: CheckpointSyncerType.LocalStorage,
                  path: '/tmp/arbitrum-test-validator-0',
                },
              },
            ],
          },
        },
      },
    };

    const manager = new ValidatorHelmManager(config, 'arbitrum');
    const values = await manager.helmValues();
    const publicRpcUrls = values.hyperlane.chains[0].publicRpcUrls;

    expect(publicRpcUrls).to.include('https://arbitrum-one-rpc.publicnode.com');
    expect(publicRpcUrls).not.to.include('https://arbitrum.drpc.org');
    expect(publicRpcUrls).not.to.include('https://arb1.arbitrum.io/rpc');
  });
});
