import { expect } from 'chai';
import sinon from 'sinon';

import { AgentSignerKeyType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts.js';
import { agents } from '../config/environments/mainnet3/agent.js';
import { AgentCli } from '../scripts/agents/utils.js';
import { AgentGCPKey } from '../src/agents/gcp.js';
import { AgentGcpKmsKey } from '../src/agents/gcp-kms/kms-key.js';
import { ValidatorHelmManager } from '../src/agents/index.js';
import { validatorAddressesForChains } from '../src/agents/key-utils.js';
import type { HelmRootAgentValues } from '../src/config/agent/agent.js';
import { CheckpointSyncerType } from '../src/config/agent/validator.js';
import { Role } from '../src/roles.js';
import {
  HelmCommand,
  HelmManager,
  type HelmValues,
} from '../src/utils/helm.js';

const config = agents[Contexts.Hyperlane];

function helmValues(): HelmRootAgentValues {
  return {
    image: { repository: 'ghcr.io/hyperlane-xyz/hyperlane-agent', tag: 'test' },
    serviceAccount: {
      name: 'ethereum-validator',
      annotations: {
        'iam.gke.io/gcp-service-account':
          'validator@test.iam.gserviceaccount.com',
      },
    },
    hyperlane: {
      runEnv: 'mainnet3',
      context: Contexts.Hyperlane,
      aws: false,
      chains: [{ name: 'ethereum' }],
      validator: {
        enabled: true,
        configs: [
          {
            originChainName: 'ethereum',
            validator: {
              type: AgentSignerKeyType.Gcp,
              keyVersionName: 'projects/test/cryptoKeyVersions/1',
            },
            checkpointSyncer: {
              type: CheckpointSyncerType.Gcs,
              bucket: 'test-checkpoints',
              folder: 'ethereum',
            },
          },
        ],
      },
    },
  };
}

class SnapshotValidator extends ValidatorHelmManager {
  proposed = helmValues();
  deployed: HelmValues | null = helmValues();
  renders = 0;
  readError?: Error;

  constructor() {
    super(config, 'ethereum');
  }

  override async helmValues(): Promise<HelmRootAgentValues> {
    this.renders++;
    return this.proposed;
  }

  override async getDeployedHelmValues(options?: {
    throwOnError?: boolean;
  }): Promise<HelmValues | null> {
    expect(options?.throwOnError).to.equal(true);
    if (this.readError) throw this.readError;
    return this.deployed;
  }

  get validatorConfig() {
    return this.config;
  }
}

class PreflightCli extends AgentCli {
  approvals: string[][] = [];
  approve = false;

  async check(manager: SnapshotValidator): Promise<boolean> {
    return this.runPreflightChecks({ validator: manager });
  }

  protected override async confirmResourceProvisioning(
    releases: string[],
  ): Promise<boolean> {
    this.approvals.push(releases);
    return this.approve;
  }
}

describe('GCP validator redeployment', () => {
  afterEach(() => sinon.restore());

  it('reports key-only changes even when the image and chain are unchanged', async () => {
    const manager = new SnapshotValidator();
    const entry = manager.proposed.hyperlane.validator?.configs?.[0];
    assert(entry, 'Expected validator config');
    entry.validator = {
      type: AgentSignerKeyType.Gcp,
      keyVersionName: 'projects/test/cryptoKeyVersions/2',
    };

    const diff = await manager.getPreflightDiff();
    expect(diff.imageDiff.hasChanges).to.equal(false);
    expect(diff.chainDiff.hasChanges).to.equal(false);
    expect(diff.resourceChanges).to.deep.equal(['Validator 0 signing key']);
  });

  it('reports service-account, storage, and additional-index changes', async () => {
    const manager = new SnapshotValidator();
    manager.proposed.serviceAccount = { name: 'replacement' };
    const configs = manager.proposed.hyperlane.validator?.configs;
    assert(configs?.[0], 'Expected validator config');
    configs[0].checkpointSyncer = {
      type: CheckpointSyncerType.Gcs,
      bucket: 'replacement',
    };
    configs.push(structuredClone(configs[0]));

    const diff = await manager.getPreflightDiff();
    expect(diff.resourceChanges).to.include.members([
      'Service account / Workload Identity',
      'Validator 0 checkpoint storage',
      'Validator 1 signing key',
      'Validator 1 checkpoint storage',
    ]);
  });

  it('aborts preflight when deployed values cannot be read', async () => {
    const manager = new SnapshotValidator();
    manager.readError = new Error('permission denied');
    await manager.getPreflightDiff().then(
      () => expect.fail('Preflight should fail'),
      (error: unknown) => expect(error).to.equal(manager.readError),
    );
    expect(manager.renders).to.equal(0);
    sinon.stub(console, 'log');
    const cli = new PreflightCli();
    cli.skipConfirmation = true;
    expect(await cli.check(manager)).to.equal(false);
    expect(cli.approvals).to.deep.equal([]);
  });

  it('requires resource confirmation even with --yes', async () => {
    sinon.stub(console, 'log');
    const manager = new SnapshotValidator();
    manager.deployed = null;
    const cli = new PreflightCli();
    cli.skipConfirmation = true;

    expect(await cli.check(manager)).to.equal(false);
    expect(cli.approvals).to.deep.equal([[manager.helmReleaseName]]);
    cli.approve = true;
    expect(await cli.check(manager)).to.equal(true);
  });

  it('requires confirmation for resource-only changes on an existing release', async () => {
    sinon.stub(console, 'log');
    const manager = new SnapshotValidator();
    const entry = manager.proposed.hyperlane.validator?.configs?.[0];
    assert(entry, 'Expected validator config');
    entry.chainSigner = { type: AgentSignerKeyType.Hex };
    const diff = await manager.getPreflightDiff();
    expect(diff.resourceChanges).to.deep.equal(['Validator 0 chain signer']);
    const cli = new PreflightCli();
    cli.skipConfirmation = true;

    expect(await cli.check(manager)).to.equal(false);
    expect(cli.approvals).to.deep.equal([[manager.helmReleaseName]]);
  });

  it('reuses resources and renders once for an image-only upgrade', async () => {
    const manager = new SnapshotValidator();
    manager.proposed.image.tag = 'replacement';
    const provision = sinon
      .stub(manager.validatorConfig, 'provisionGcpResources')
      .resolves([]);
    const install = sinon
      .stub(HelmManager.prototype, 'runHelmCommand')
      .resolves();

    await manager.runHelmCommand(HelmCommand.InstallOrUpgrade);

    expect(provision.called).to.equal(false);
    expect(manager.renders).to.equal(1);
    expect(install.firstCall.args[2]).to.equal(manager.proposed);
  });

  it('refuses unconfirmed provisioning before touching cloud resources', async () => {
    const manager = new SnapshotValidator();
    manager.deployed = null;
    const provision = sinon
      .stub(manager.validatorConfig, 'provisionGcpResources')
      .resolves([]);
    const install = sinon
      .stub(HelmManager.prototype, 'runHelmCommand')
      .resolves();

    await manager.runHelmCommand(HelmCommand.InstallOrUpgrade).then(
      () => expect.fail('Provisioning should require confirmation'),
      (error: unknown) => {
        expect(error).to.be.instanceOf(Error);
        assert(error instanceof Error, 'Expected error');
        expect(error.message).to.contain('require confirmation');
      },
    );
    expect(provision.called).to.equal(false);
    expect(install.called).to.equal(false);
  });

  it('provisions an approved new release and retains its fetched keys', async () => {
    const manager = new SnapshotValidator();
    manager.deployed = null;
    const key = new AgentGcpKmsKey(config, Role.Validator, 0);
    const provision = sinon
      .stub(manager.validatorConfig, 'provisionGcpResources')
      .resolves([key]);
    const install = sinon
      .stub(HelmManager.prototype, 'runHelmCommand')
      .resolves();

    await manager.runHelmCommand(HelmCommand.InstallOrUpgrade, {
      allowResourceProvisioning: true,
    });

    expect(
      provision.calledOnceWithExactly(
        manager.namespace,
        manager.helmReleaseName,
      ),
    ).to.equal(true);
    expect(manager.provisionedKeys).to.deep.equal([key]);
    expect(install.calledOnce).to.equal(true);
    expect(manager.renders).to.equal(1);
  });

  it('does not provision during a dry run', async () => {
    const manager = new SnapshotValidator();
    manager.deployed = null;
    const provision = sinon
      .stub(manager.validatorConfig, 'provisionGcpResources')
      .resolves([]);
    sinon.stub(HelmManager.prototype, 'runHelmCommand').resolves();

    await manager.runHelmCommand(HelmCommand.InstallOrUpgrade, {
      dryRun: true,
    });

    expect(provision.called).to.equal(false);
    expect(manager.renders).to.equal(1);
  });

  it('maps a shared KMS key to only the deployed chains', () => {
    const key = new AgentGcpKmsKey(config, Role.Validator, 0);
    key.remoteKey = {
      fetched: true,
      address: '0x0000000000000000000000000000000000000001',
    };
    expect(
      validatorAddressesForChains(config, [key], ['ethereum', 'solanamainnet']),
    ).to.deep.equal({
      ethereum: { validators: [key.address] },
      solanamainnet: { validators: [key.address] },
    });
  });

  it('fails when a manually provisioned Starknet transaction key is missing', async () => {
    const key = new AgentGCPKey(
      'mainnet3',
      Contexts.Hyperlane,
      Role.Validator,
      'starknet',
      0,
    );
    sinon.stub(key, 'fetch').rejects(new Error('NOT_FOUND'));

    await key.createIfNotExists().then(
      () => expect.fail('Starknet requires an existing key'),
      (error: unknown) => {
        assert(error instanceof Error, 'Expected error');
        expect(error.message).to.contain(
          'Starknet keys must be manually added',
        );
      },
    );
  });
});
