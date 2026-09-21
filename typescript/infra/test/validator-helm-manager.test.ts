import { expect } from 'chai';

import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts.js';
import { agents } from '../config/environments/mainnet3/agent.js';
import { agents as testnetAgents } from '../config/environments/testnet4/agent.js';
import { agents as localAgents } from '../config/environments/test/agent.js';
import { Role } from '../src/roles.js';
import type { RootAgentConfig } from '../src/config/agent/agent.js';
import { CheckpointSyncerType } from '../src/config/agent/validator.js';

import { ValidatorHelmManager } from '../src/agents/index.js';

describe('ValidatorHelmManager', () => {
  it('uses majority for every configured validator context', () => {
    for (const config of [
      ...Object.values(agents),
      ...Object.values(testnetAgents),
      ...Object.values(localAgents),
    ]) {
      expect(
        config.validators?.rpcConsensusType,
        `${config.runEnv}/${config.context}`,
      ).to.equal('majority');
    }
    expect(agents[Contexts.FastPath].validators?.websocketUrl).to.be.undefined;
  });

  it('preserves validator quorum and majority on AltVMs', () => {
    for (const rpcConsensusType of [
      RpcConsensusType.Quorum,
      RpcConsensusType.Majority,
    ]) {
      const base = agents[Contexts.Hyperlane];
      if (!base.validators) throw new Error('Expected validator configuration');
      const manager = new ValidatorHelmManager(
        {
          ...base,
          validators: { ...base.validators, rpcConsensusType },
        },
        'solanamainnet',
      );
      for (const chain of [
        'solanamainnet',
        'celestia',
        'tron',
        'starknet',
        'radix',
        'aleo',
      ]) {
        expect(manager.rpcConsensusType(chain), chain).to.equal(
          rpcConsensusType,
        );
      }
    }
  });

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
        index: { from: -10_000 },
        websocketUrl:
          'ws://scraper-proxy.mainnet3.svc.cluster.local:8383/agents',
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
    expect(values.hyperlane.chains[0].index?.from).to.equal(-10_000);
    expect(values.hyperlane.validator?.configs).to.have.lengthOf(1);
    expect(values.hyperlane.validator?.configs?.[0].interval).to.equal(1);
    expect(values.hyperlane.validator?.configs?.[0].websocketUrl).to.equal(
      'ws://scraper-proxy.mainnet3.svc.cluster.local:8383/agents',
    );
  });
});
