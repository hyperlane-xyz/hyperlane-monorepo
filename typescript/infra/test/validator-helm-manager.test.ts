import { expect } from 'chai';
import sinon from 'sinon';

import { AgentSignerKeyType, RpcConsensusType } from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts.js';
import { Role } from '../src/roles.js';
import type { RootAgentConfig } from '../src/config/agent/agent.js';
import { CheckpointSyncerType } from '../src/config/agent/validator.js';

import { AgentAwsKey } from '../src/agents/aws/key.js';
import { ValidatorHelmManager } from '../src/agents/index.js';
import { ValidatorAgentAwsUser } from '../src/agents/aws/validator-user.js';

describe('ValidatorHelmManager', () => {
  afterEach(() => sinon.restore());

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

  it('separates custom S3 credentials from AWS signer provisioning', async () => {
    const createUser = sinon.stub(
      ValidatorAgentAwsUser.prototype,
      'createIfNotExists',
    );
    const createBucket = sinon.stub(
      ValidatorAgentAwsUser.prototype,
      'createBucketIfNotExists',
    );
    const createKey = sinon.stub(
      ValidatorAgentAwsUser.prototype,
      'createKeyIfNotExists',
    );
    createKey.callsFake(
      async (agentConfig) =>
        new AgentAwsKey(agentConfig, Role.Validator, 'sepolia', 0),
    );
    const config: RootAgentConfig = {
      runEnv: 'testnet4',
      namespace: 'test',
      context: Contexts.FastPath,
      aws: { region: 'us-east-1' },
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
                  type: CheckpointSyncerType.S3,
                  bucket: 'test-bucket',
                  region: 'nyc3',
                  endpoint: 'https://nyc3.digitaloceanspaces.com',
                  credentials: {
                    accessKeyIdSecret: 'do-spaces-access-key-id',
                    secretAccessKeySecret: 'do-spaces-secret-access-key',
                  },
                },
              },
            ],
          },
        },
      },
    };

    const manager = new ValidatorHelmManager(config, 'sepolia');
    const values = await manager.helmValues();
    const validator = values.hyperlane.validator?.configs?.[0];

    sinon.assert.calledOnce(createUser);
    sinon.assert.notCalled(createBucket);
    sinon.assert.calledOnce(createKey);
    expect(validator?.checkpointSyncer).to.deep.equal({
      type: CheckpointSyncerType.S3,
      bucket: 'test-bucket',
      region: 'nyc3',
      endpoint: 'https://nyc3.digitaloceanspaces.com',
    });
    expect(validator?.checkpointSyncerCredentials).to.deep.equal({
      accessKeyIdSecret: 'do-spaces-access-key-id',
      secretAccessKeySecret: 'do-spaces-secret-access-key',
    });
    expect(validator?.validator).to.deep.equal({
      type: AgentSignerKeyType.Aws,
      id: 'alias/fastpath-testnet4-key-validator-0',
      region: 'us-east-1',
    });
    expect(validator?.chainSigner).to.deep.equal(validator?.validator);
  });
});
