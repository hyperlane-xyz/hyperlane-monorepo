import { address, type Address } from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { before, describe, it } from 'mocha';

chai.use(chaiAsPromised);

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { IgpHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import { sleep } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { DEFAULT_IGP_SALT, SvmIgpHookWriter } from '../hook/igp-hook.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { LEGACY_SVM_PROGRAM_BYTES } from '../testing/legacy/legacy-program-bytes.js';
import { airdropSol } from '../testing/setup.js';
import { supportsFeeConfig } from '../version/version-query.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

// `skipPreflight` and the post-send sleep below are test-validator-only
// workarounds. The local test validator confirms much faster than mainnet,
// so without these guards the follow-up read can race the validator's
// program cache and see stale state.

describe('SVM IGP Program Upgrade E2E Tests', function () {
  this.timeout(600_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      TEST_SVM_CHAIN_METADATA,
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 100_000_000_000n);
  });

  const baseConfig = (): IgpHookConfig => ({
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    owner: signer.getSignerAddress(),
    beneficiary: signer.getSignerAddress(),
    oracleKey: signer.getSignerAddress(),
    overhead: { 1: 50000 },
    oracleConfig: {
      1: { gasPrice: '1', tokenExchangeRate: '1000000000000000000' },
    },
  });

  it('should upgrade IGP from legacy and set fee config in one update', async () => {
    const SIGNER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const SIGNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const DOMAIN_ID = 1;

    const legacyWriter = new SvmIgpHookWriter(
      {
        program: { programBytes: LEGACY_SVM_PROGRAM_BYTES.igp },
        domainId: DOMAIN_ID,
      },
      rpc,
      DEFAULT_IGP_SALT,
      signer,
    );

    const [deployed] = await legacyWriter.create({
      artifactState: ArtifactState.NEW,
      config: baseConfig(),
    });

    const programId: Address = deployed.deployed.programId;
    const legacyRead = await legacyWriter.read(programId);
    expect(legacyRead.config.contractVersion).to.be.undefined;
    expect(legacyRead.deployed.feeConfig).to.be.undefined;

    const newWriter = new SvmIgpHookWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.igp },
        domainId: DOMAIN_ID,
      },
      rpc,
      DEFAULT_IGP_SALT,
      signer,
    );

    const updateTxs = await newWriter.update({
      ...legacyRead,
      config: {
        ...legacyRead.config,
        contractVersion: '1.0.0',
        quoteSigners: [SIGNER_A, SIGNER_B],
      },
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    for (const tx of updateTxs) {
      await signer.send({
        instructions: tx.instructions,
        additionalSigners: tx.additionalSigners,
        skipPreflight: true,
      });
    }

    await sleep(1000);
    const upgraded = await newWriter.read(programId);
    expect(upgraded.config.contractVersion).to.be.a('string');
    expect(supportsFeeConfig(upgraded.config.contractVersion)).to.equal(true);
    expect(upgraded.deployed.feeConfig?.domainId).to.equal(DOMAIN_ID);
    expect(upgraded.deployed.feeConfig?.minIssuedAt).to.equal(0n);
    expect(new Set(upgraded.config.quoteSigners ?? [])).to.eql(
      new Set([SIGNER_A, SIGNER_B]),
    );
  });

  it('should reject setting fee config without a supporting program version', async () => {
    const SIGNER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const legacyWriter = new SvmIgpHookWriter(
      {
        program: { programBytes: LEGACY_SVM_PROGRAM_BYTES.igp },
        domainId: 1,
      },
      rpc,
      DEFAULT_IGP_SALT,
      signer,
    );

    const [deployed] = await legacyWriter.create({
      artifactState: ArtifactState.NEW,
      config: baseConfig(),
    });

    const programId: Address = deployed.deployed.programId;
    const legacyRead = await legacyWriter.read(programId);

    // No programBytes → no upgrade fires; the version gate must reject any
    // attempt to set fee config on the legacy binary still on-chain.
    const noUpgradeWriter = new SvmIgpHookWriter(
      { program: { programId }, domainId: 1 },
      rpc,
      DEFAULT_IGP_SALT,
      signer,
    );

    await expect(
      noUpgradeWriter.update({
        ...legacyRead,
        config: { ...legacyRead.config, quoteSigners: [SIGNER_A] },
      }),
    ).to.be.rejectedWith(/does not support fee config/);
  });

  it('should reject IGP downgrade attempt', async () => {
    const writer = new SvmIgpHookWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.igp },
        domainId: 1,
      },
      rpc,
      DEFAULT_IGP_SALT,
      signer,
    );

    const [deployed] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: baseConfig(),
    });

    const programId: Address = deployed.deployed.programId;
    const current = await writer.read(programId);
    expect(current.config.contractVersion).to.equal('1.0.0');

    await expect(
      writer.update({
        ...current,
        config: { ...current.config, contractVersion: '0.1.0' },
      }),
    ).to.be.rejectedWith('Cannot downgrade');
  });

  it('should skip IGP upgrade when contractVersion matches', async () => {
    const writer = new SvmIgpHookWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.igp },
        domainId: 1,
      },
      rpc,
      DEFAULT_IGP_SALT,
      signer,
    );

    const [deployed] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: baseConfig(),
    });

    const programId: Address = deployed.deployed.programId;
    const current = await writer.read(programId);

    const updateTxs = await writer.update({
      ...current,
      config: { ...current.config },
    });

    expect(updateTxs).to.have.length(0);
  });
});
