import { expect } from 'chai';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import { SealevelSigner, createRpc } from '@hyperlane-xyz/sealevel-sdk';
import { airdropSol } from '@hyperlane-xyz/sealevel-sdk/testing';
import {
  TokenFeeType,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import { syncWarpDeployConfigToRegistry } from '../../commands/warp-config-sync.js';
import {
  CORE_ADDRESSES_PATH_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  getWarpCoreConfigPath,
} from '../../constants.js';

const CHAIN_NAME = 'svmlocal1';
const SVM_KEY = HYP_KEY_BY_PROTOCOL.sealevel;
const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/svm-alt-warp-deploy.yaml`;

const SVM_WARP_ALT_TIMEOUT = 600_000;

describe('hyperlane warp alt CLI e2e tests (Sealevel)', function () {
  this.timeout(SVM_WARP_ALT_TIMEOUT);

  let signer: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;
  let mailboxAddress: string;

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/svm-alt-warp-read.yaml`,
  );

  before(async function () {
    const rpcUrl = TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl;
    const rpc = createRpc(rpcUrl);
    signer = await SealevelSigner.connectWithSigner([rpcUrl], SVM_KEY);

    await airdropSol(rpc, signer.getSignerAddress(), 50_000_000_000n);

    const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
      ProtocolType.Sealevel,
      CHAIN_NAME,
      REGISTRY_PATH,
      CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );

    const coreConfig = readYamlOrJson(CORE_CONFIG_PATH_BY_PROTOCOL.sealevel);
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      coreConfig,
    );
    hyperlaneCore.setCoreInputPath(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );
    await hyperlaneCore.deploy(SVM_KEY);

    const coreAddresses: ChainAddresses = readYamlOrJson(
      CORE_ADDRESSES_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );
    mailboxAddress = coreAddresses.mailbox;
  });

  it('creates ALTs, populates registry, and check exits clean', async function () {
    const ownerAddress = signer.getSignerAddress();
    const SYMBOL = 'ALTKN';

    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
    const config: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.native,
        name: 'ALT Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, config);
    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    // Before create — no alt entries in the registry.
    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const preCreate: WarpCoreConfig = readYamlOrJson(warpCorePath);
    expect(preCreate.options?.sealevel?.altAddresses?.[CHAIN_NAME]).to.equal(
      undefined,
    );

    // Create both ALTs and persist them to the registry.
    await warpCommands.altCreate(SVM_KEY, warpRouteId);

    const postCreate: WarpCoreConfig = readYamlOrJson(warpCorePath);
    const altEntry = postCreate.options?.sealevel?.altAddresses?.[CHAIN_NAME];
    expect(altEntry, 'sealevel.altAddresses entry written').to.be.an('object');
    expect(altEntry!.core, 'core ALT is a non-empty string')
      .to.be.a('string')
      .and.to.have.length.greaterThan(0);
    expect(altEntry!.warpSpecific, 'warpSpecific is non-empty array')
      .to.be.an('array')
      .with.lengthOf(1);
    expect(altEntry!.warpSpecific[0])
      .to.be.a('string')
      .and.to.have.length.greaterThan(0);

    // `warp alt read` exits 0 and prints the on-chain ALT contents.
    await warpCommands.altRead(warpRouteId);

    // `warp alt check` exits 0 immediately after create — no diffs.
    await warpCommands.altCheck(warpRouteId);
  });

  it('--force reuses core ALT; --full-force regenerates everything', async function () {
    const ownerAddress = signer.getSignerAddress();
    const SYMBOL = 'ALTFRC';
    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);

    const config: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.native,
        name: 'Force ALT Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, config);
    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    function readAltEntry() {
      const entry =
        readYamlOrJson<WarpCoreConfig>(warpCorePath).options?.sealevel
          ?.altAddresses?.[CHAIN_NAME];
      assert(entry, `expected altAddresses entry for ${CHAIN_NAME}`);
      return entry;
    }

    // Baseline: create core + warp-specific from scratch.
    await warpCommands.altCreate(SVM_KEY, warpRouteId);
    const baseline = readAltEntry();

    // --force regenerates warp-specific ALTs but reuses the core ALT.
    // The on-chain ALT program assigns a fresh address on every create,
    // so a regenerated warp-specific entry is detectable as a strictly
    // different address even though the contents are identical.
    await warpCommands.altCreate(SVM_KEY, warpRouteId, { force: true });
    const afterForce = readAltEntry();
    expect(afterForce.core, '--force preserves core ALT address').to.equal(
      baseline.core,
    );
    expect(
      afterForce.warpSpecific.every((a) => !baseline.warpSpecific.includes(a)),
      `--force should regenerate every warp-specific address (baseline=${baseline.warpSpecific}, after=${afterForce.warpSpecific})`,
    ).to.equal(true);

    // --full-force regenerates the core ALT too.
    await warpCommands.altCreate(SVM_KEY, warpRouteId, { fullForce: true });
    const afterFull = readAltEntry();
    expect(afterFull.core, '--full-force regenerates core ALT').to.not.equal(
      baseline.core,
    );
    expect(
      afterFull.warpSpecific.every((a) => !afterForce.warpSpecific.includes(a)),
      `--full-force should regenerate every warp-specific address (after-force=${afterForce.warpSpecific}, after-full=${afterFull.warpSpecific})`,
    ).to.equal(true);

    // Post-`--full-force` state is still consistent with on-chain ALTs.
    await warpCommands.altCheck(warpRouteId);
  });

  it('check exits non-zero when warp config drifts from registered ALTs', async function () {
    const ownerAddress = signer.getSignerAddress();
    const SYMBOL = 'ALTSTL';
    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);

    // Deploy with a LinearFee and no remote routers — the fee cascade
    // depends on enrolled routers, so adding one later changes the
    // expected ALT contents.
    const initialConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.native,
        name: 'Stale ALT Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ownerAddress,
          bps: 50,
        },
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, initialConfig);
    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    // Create ALTs covering the initial 0-router cascade.
    await warpCommands.altCreate(SVM_KEY, warpRouteId);

    // Check is clean immediately after create.
    await warpCommands.altCheck(warpRouteId);

    // Apply a config that adds a remote router — the on-chain warp
    // now enrolls a new destination, so the fee cascade for that
    // destination should be added to the expected set.
    const updatedConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        ...initialConfig[CHAIN_NAME],
        remoteRouters: {
          anvil1: {
            address:
              '0x1111111111111111111111111111111111111111111111111111111111111111',
          },
        },
        destinationGas: {
          anvil1: '42000',
        },
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, updatedConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpRouteId,
      registryPath: REGISTRY_PATH,
    });
    await warpCommands.applyRaw({
      warpRouteId,
      privateKey: SVM_KEY,
      skipConfirmationPrompts: true,
    });

    // Check now reports a diff and exits non-zero. Assert on both the
    // exit code and the rendered diff so unrelated failures (e.g. a
    // CLI startup error) don't accidentally make this pass.
    const result = await warpCommands.altCheck(warpRouteId).nothrow();
    expect(result.exitCode, 'altCheck should exit non-zero').to.not.equal(0);
    expect(result.stdout).to.include(
      'Warp route ALT check failed: diffs detected',
    );
    expect(result.stdout).to.match(/missingFromAlt:\s*\n\s+-/);
    // The annotated diff names the missing entry by its semantic
    // role — the new destination's per-domain fee standing-quote PDA.
    expect(result.stdout).to.include(
      'description: fee.standing_quote(domain=31337)',
    );
  });
});
