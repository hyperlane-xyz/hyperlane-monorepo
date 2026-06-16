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
    expect(values.hyperlane.validator?.configs).to.have.lengthOf(1);
    expect(values.hyperlane.validator?.configs?.[0].interval).to.equal(1);
  });
});
