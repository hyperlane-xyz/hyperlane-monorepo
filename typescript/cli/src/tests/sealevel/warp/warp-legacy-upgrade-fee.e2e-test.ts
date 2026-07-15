import { expect } from 'chai';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import { TokenType as ArtifactTokenType } from '@hyperlane-xyz/provider-sdk/warp';
import {
  SealevelSigner,
  SvmCrossCollateralTokenReader,
  SvmCrossCollateralTokenWriter,
  SvmWarpArtifactManager,
  createRpc,
} from '@hyperlane-xyz/sealevel-sdk';
import {
  LEGACY_SVM_PROGRAM_BYTES,
  TEST_ATA_PAYER_FUNDING_AMOUNT,
  airdropSol,
  createSplMint,
} from '@hyperlane-xyz/sealevel-sdk/testing';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  TokenFeeType,
  TokenStandard,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { syncWarpDeployConfigToRegistry } from '../../commands/warp-config-sync.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
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
const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/svm-legacy-upgrade-fee-deploy.yaml`;

const SVM_LEGACY_UPGRADE_FEE_TIMEOUT = 600_000;

// BPF Upgradeable Loader. Each deployed program owns a ProgramData account
// under this loader; the upgrade authority pubkey lives at byte offset 13
// (4-byte enum tag + 8-byte slot + 1-byte Option flag).
const LOADER_V3 = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAM_DATA_AUTHORITY_FLAG_OFFSET = 12;
const PROGRAM_DATA_AUTHORITY_OFFSET = 13;
const PROGRAM_DATA_HEADER_SIZE = 45;

// Base config for the legacy cross-collateral route deployed directly via the
// svm-sdk writer. Typed explicitly so a future required field on the artifact
// config surfaces as a compile error here rather than silently defaulting.
interface LegacyCcCreateConfig {
  type: typeof ArtifactTokenType.crossCollateral;
  owner: string;
  mailbox: string;
  token: string;
  remoteRouters: Record<number, { address: string }>;
  destinationGas: Record<number, string>;
  crossCollateralRouters: Record<number, Set<string>>;
}

/**
 * Returns the set of program addresses whose ProgramData upgrade authority is
 * `authority`. Diffing this set across the apply reveals every program the
 * apply deployed — the fee-program deploy in the writer's `update` build is a
 * non-idempotent on-chain side effect, so a retry loop leaves more than one.
 */
async function programsOwnedBy(
  connection: Connection,
  authority: string,
): Promise<Set<string>> {
  const accounts = await connection.getProgramAccounts(LOADER_V3);
  const owned = new Set<string>();
  for (const { pubkey, account } of accounts) {
    const data = account.data;
    if (data.length < PROGRAM_DATA_HEADER_SIZE) continue;
    if (data[PROGRAM_DATA_AUTHORITY_FLAG_OFFSET] !== 1) continue;
    const authorityKey = new PublicKey(
      data.subarray(PROGRAM_DATA_AUTHORITY_OFFSET, PROGRAM_DATA_HEADER_SIZE),
    );
    if (authorityKey.toBase58() === authority) {
      owned.add(pubkey.toBase58());
    }
  }
  return owned;
}

describe('hyperlane warp legacy-upgrade + fee apply CLI e2e tests (Sealevel)', function () {
  this.timeout(SVM_LEGACY_UPGRADE_FEE_TIMEOUT);

  let signer: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;
  let rpc: ReturnType<typeof createRpc>;
  let connection: Connection;
  let mailboxAddress: string;

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/svm-legacy-upgrade-fee-read.yaml`,
  );

  before(async function () {
    const rpcUrl = TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl;
    rpc = createRpc(rpcUrl);
    connection = new Connection(rpcUrl, 'confirmed');
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

  it('should upgrade a legacy route and add a fee in a single apply without redeploying fee programs', async function () {
    const ownerAddress = signer.getSignerAddress();
    const SYMBOL = 'LEGUP';
    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);

    const mint = await createSplMint(rpc, signer, 9);

    // 1. Deploy a pre-v1 cross-collateral route directly with legacy bytes.
    // The CLI cannot deploy legacy bytes, so the svm-sdk writer stands in for
    // a route that predates fee-program support.
    const legacyConfig: LegacyCcCreateConfig = {
      type: ArtifactTokenType.crossCollateral,
      owner: ownerAddress,
      mailbox: mailboxAddress,
      token: String(mint),
      remoteRouters: {},
      destinationGas: {},
      crossCollateralRouters: {},
    };
    const legacyWriter = new SvmCrossCollateralTokenWriter(
      {
        program: {
          programBytes: LEGACY_SVM_PROGRAM_BYTES.tokenCrossCollateral,
        },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
      },
      rpc,
      signer,
    );
    const [deployed] = await legacyWriter.create({ config: legacyConfig });
    const router = deployed.deployed.address;

    const legacyRead = await new SvmCrossCollateralTokenReader(rpc).read(
      router,
    );
    expect(legacyRead.config.contractVersion).to.be.undefined;

    // 2. Register the route in the registry so `warp apply` can find it. The
    // core config carries the router address; the deploy config is the desired
    // state.
    const deployConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.crossCollateral,
        token: String(mint),
        name: 'Legacy Upgrade Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, deployConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpRouteId,
      registryPath: REGISTRY_PATH,
    });

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const warpCoreConfig: WarpCoreConfig = {
      tokens: [
        {
          chainName: CHAIN_NAME,
          standard: TokenStandard.SealevelHypCrossCollateral,
          tokenType: TokenType.crossCollateral,
          decimals: 9,
          symbol: SYMBOL,
          name: 'Legacy Upgrade Token',
          addressOrDenom: router,
          collateralAddressOrDenom: String(mint),
        },
      ],
    };
    writeYamlOrJson(warpCorePath, warpCoreConfig);

    // 3. Apply a config that both triggers the program upgrade
    // (`contractVersion`) and adds a fee. The fee deploy happens inside the
    // per-chain build wrapped by `retryAsync` in `updateExistingWarpRoute`;
    // a build that throws after the fee deploy would re-run and deploy another
    // fee program.
    const applyConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.crossCollateral,
        token: String(mint),
        name: 'Legacy Upgrade Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
        contractVersion: '1.0.0',
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ownerAddress,
          bps: 50,
        },
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, applyConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpRouteId,
      registryPath: REGISTRY_PATH,
    });

    const programsBefore = await programsOwnedBy(connection, ownerAddress);

    const result = await warpCommands
      .applyRaw({
        warpRouteId,
        privateKey: SVM_KEY,
        skipConfirmationPrompts: true,
      })
      .nothrow();

    // The signer is well-funded (50 SOL), so this apply should not fail on
    // funds alone. Surface the CLI output regardless so a reproduced loop or
    // failed upgrade is diagnosable from the test log.
    console.log('[warp apply] exit code:', result.exitCode);
    console.log('[warp apply] stdout:\n', result.stdout);
    console.log('[warp apply] stderr:\n', result.stderr);

    const programsAfter = await programsOwnedBy(connection, ownerAddress);
    const newPrograms = [...programsAfter].filter(
      (p) => !programsBefore.has(p),
    );
    console.log('[warp apply] programs deployed during apply:', newPrograms);

    // Exactly one program (the fee program) should be deployed by the apply.
    // A retry loop over the non-idempotent fee deploy produces more than one.
    expect(newPrograms.length).to.equal(1);

    // The upgrade must land and the fee must attach on-chain.
    const upgraded = await new SvmWarpArtifactManager(rpc, {
      chainName: CHAIN_NAME,
    }).readWarpToken(router);
    assert(
      upgraded.config.contractVersion,
      'Expected contractVersion to be set after upgrade',
    );

    const afterApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const fee = afterApply[CHAIN_NAME].tokenFee;
    assert(fee, 'Expected tokenFee after apply');
    assert(
      fee.type === TokenFeeType.LinearFee,
      `Expected LinearFee, got ${fee.type}`,
    );
    expect(fee.bps).to.equal(50);
  });
});
