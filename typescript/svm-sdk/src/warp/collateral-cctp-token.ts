import {
  type Address,
  address as parseAddress,
  fetchEncodedAccount,
} from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  TokenType,
  type CctpRemoteConfig,
  type RawCollateralCctpWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  ZERO_ADDRESS_HEX_32,
  assert,
  isNullish,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { fetchMintMetadata, getMintDecimals } from '../accounts/mint.js';
import {
  decodeCctpPlugin,
  decodeCctpRemoteConfigAccount,
} from '../accounts/token.js';
import type { SvmSigner } from '../clients/signer.js';
import {
  DEFAULT_COMPUTE_UNITS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../constants.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import { getTokenInitInstruction } from '../instructions/token.js';
import { getCctpSetRemoteConfigInstruction } from '../instructions/token-cctp.js';
import { readonlyAccount, writableAccount } from '../instructions/utils.js';
import {
  deriveCctpAtaPayerPda,
  deriveCctpRemoteConfigPda,
  deriveHyperlaneTokenPda,
} from '../pda.js';
import { hasProgramBytes } from '../types.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

import type { SvmDeployedWarpAddress, SvmWarpTokenConfig } from './types.js';
import { prepareProgramUpgrade } from '../deploy/program-upgrade.js';
import {
  fetchCctpTokenAccount,
  fetchWarpProgramVersion,
  routerBytesToHex,
} from './warp-query.js';
import {
  applyPostInitConfig,
  assertLocalDecimals,
  buildBaseInitData,
  buildFundAtaPayerInstruction,
  computeWarpTokenUpdateInstructions,
  remoteDecimalsToScale,
  scaleToRemoteDecimals,
} from './warp-tx.js';

export class SvmCollateralCctpTokenReader implements ArtifactReader<
  RawCollateralCctpWarpArtifactConfig,
  SvmDeployedWarpAddress
> {
  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    programAddress: string,
  ): Promise<
    ArtifactDeployed<
      RawCollateralCctpWarpArtifactConfig,
      SvmDeployedWarpAddress
    >
  > {
    const programId = parseAddress(programAddress);
    const token = await fetchCctpTokenAccount(this.rpc, programId);
    assert(!isNullish(token), `CCTP token not initialized at ${programId}`);

    const plugin = decodeCctpPlugin(token.pluginData);

    const remoteRouters: Record<number, { address: string }> = {};
    for (const [domain, router] of token.remoteRouters.entries()) {
      remoteRouters[domain] = { address: routerBytesToHex(router) };
    }

    const destinationGas: Record<number, string> = {};
    for (const [domain, gas] of token.destinationGas.entries()) {
      destinationGas[domain] = gas.toString();
    }

    // The set of configured destination domains isn't tracked independently
    // on-chain — reuse the enrolled remote-router domains as the set of
    // domains to look up a RemoteConfig PDA for.
    const remoteConfigEntries = await Promise.all(
      Object.keys(remoteRouters).map(async (domainStr) => {
        const domain = Number(domainStr);
        const remoteConfig = await fetchCctpRemoteConfig(
          this.rpc,
          programId,
          domain,
        );
        return [domain, remoteConfig] as const;
      }),
    );
    const remoteConfigs: Record<number, CctpRemoteConfig> = {};
    for (const [domain, remoteConfig] of remoteConfigEntries) {
      if (remoteConfig) {
        remoteConfigs[domain] = remoteConfig;
      }
    }

    const metadata = await fetchMintMetadata(this.rpc, plugin.mint);

    assert(
      token.decimals === metadata.decimals,
      `Decimals mismatch for CCTP token ${programId}: ` +
        `warp route initialized with ${token.decimals} but mint reports ${metadata.decimals}`,
    );

    const contractVersion = await fetchWarpProgramVersion(
      this.rpc,
      programId,
      token.owner,
    );

    const config: RawCollateralCctpWarpArtifactConfig = {
      type: TokenType.collateralCctp,
      owner: token.owner ?? ZERO_ADDRESS_HEX_32,
      mailbox: token.mailbox,
      token: plugin.mint,
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: token.decimals,
      // Hardcoded on-chain to the program's own address regardless of the
      // (now-unused) stored config field — see
      // `processor.rs::interchain_security_module`. Reported here as such
      // rather than read from raw storage, since raw storage is never
      // actually consulted for this answer.
      interchainSecurityModule: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: programId },
      },
      hook: token.interchainGasPaymaster
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: token.interchainGasPaymaster.programId },
          }
        : undefined,
      remoteRouters,
      destinationGas,
      remoteConfigs,
      scale: remoteDecimalsToScale(token.decimals, token.remoteDecimals),
      contractVersion: contractVersion ?? undefined,
      fee: token.feeConfig
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: token.feeConfig.feeProgram },
          }
        : undefined,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: {
        address: programId,
        feeConfig: token.feeConfig ?? undefined,
      },
    };
  }
}

export class SvmCollateralCctpTokenWriter
  extends SvmCollateralCctpTokenReader
  implements
    ArtifactWriter<RawCollateralCctpWarpArtifactConfig, SvmDeployedWarpAddress>
{
  constructor(
    private readonly config: SvmWarpTokenConfig,
    rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<RawCollateralCctpWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<
        RawCollateralCctpWarpArtifactConfig,
        SvmDeployedWarpAddress
      >,
      SvmReceipt[],
    ]
  > {
    const receipts: SvmReceipt[] = [];
    const tokenConfig = artifact.config;

    // Validate the USDC mint before deploying — same checks the on-chain
    // CctpPlugin::initialize performs.
    const mint = parseAddress(tokenConfig.token);
    const mintInfo = await this.rpc
      .getAccountInfo(mint, { encoding: 'base64' })
      .send();
    assert(!isNullish(mintInfo.value), `Mint account not found: ${mint}`);
    const splProgram = parseAddress(mintInfo.value.owner);
    assert(
      splProgram === SPL_TOKEN_PROGRAM_ADDRESS ||
        splProgram === TOKEN_2022_PROGRAM_ADDRESS,
      `Mint ${mint} is not owned by SPL Token or Token-2022 (owner: ${splProgram})`,
    );
    const mintRawData = Buffer.from(mintInfo.value.data[0], 'base64');
    const localDecimals = getMintDecimals(mintRawData);
    assertLocalDecimals(localDecimals);
    const remoteDecimals = scaleToRemoteDecimals(
      localDecimals,
      tokenConfig.scale,
    );

    // Deploy
    const { programAddress, receipts: deployReceipts } = await resolveProgram(
      this.config.program,
      this.svmSigner,
      this.rpc,
      true,
    );
    receipts.push(...deployReceipts);

    const { address: ataPayerPda } =
      await deriveCctpAtaPayerPda(programAddress);

    const initData = await buildBaseInitData(
      tokenConfig,
      localDecimals,
      remoteDecimals,
    );

    const initIx = await getTokenInitInstruction(
      programAddress,
      this.svmSigner.signer,
      initData,
      [
        readonlyAccount(splProgram),
        readonlyAccount(mint),
        writableAccount(ataPayerPda),
      ],
    );

    receipts.push(
      await this.svmSigner.send({
        instructions: [initIx],
        computeUnits: DEFAULT_COMPUTE_UNITS,
        skipPreflight: true,
      }),
    );

    const fundAtaPayerIx = await buildFundAtaPayerInstruction(
      this.rpc,
      this.svmSigner.signer.address,
      programAddress,
      this.config.ataPayerFundingAmount,
    );
    if (fundAtaPayerIx) {
      receipts.push(
        await this.svmSigner.send({ instructions: [fundAtaPayerIx] }),
      );
    }

    receipts.push(
      ...(await applyPostInitConfig(
        this.svmSigner,
        programAddress,
        tokenConfig,
        this.config.feeSalt,
      )),
    );

    receipts.push(
      ...(await sendRemoteConfigInstructions(
        this.svmSigner,
        programAddress,
        tokenConfig.remoteConfigs,
      )),
    );

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { ...tokenConfig, decimals: localDecimals },
        deployed: { address: programAddress },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<
      RawCollateralCctpWarpArtifactConfig,
      SvmDeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = parseAddress(artifact.deployed.address);
    const current = await this.read(programId);

    assert(
      !isZeroishAddress(current.config.owner),
      `Cannot update CCTP token ${programId}: token has no owner`,
    );

    const txs: AnnotatedSvmTransaction[] = [];

    let upgradingToVersion: string | undefined;
    if (hasProgramBytes(this.config.program)) {
      const upgradeResult = await prepareProgramUpgrade(
        programId,
        current.config.contractVersion,
        artifact.config.contractVersion,
        this.config.program.programBytes,
        this.svmSigner,
        this.rpc,
        `CCTP token ${programId}`,
      );
      txs.push(...(upgradeResult?.authorityTransactions ?? []));
      upgradingToVersion = upgradeResult?.authorityTransactions
        ? artifact.config.contractVersion
        : undefined;
    }

    const configUpdateTxs = await computeWarpTokenUpdateInstructions(
      current.config,
      artifact.config,
      programId,
      parseAddress(current.config.owner),
      this.rpc,
      `CCTP token ${programId}`,
      this.config.feeSalt,
      current.deployed.feeConfig,
      upgradingToVersion,
      // The ISM is hardcoded on-chain to this program's own address —
      // SetInterchainSecurityModule is rejected outright, so never diff it.
      true,
    );
    txs.push(...configUpdateTxs);

    const remoteConfigTxs = await computeCctpRemoteConfigUpdateInstructions(
      current.config.remoteConfigs,
      artifact.config.remoteConfigs,
      programId,
      parseAddress(current.config.owner),
      `CCTP token ${programId}`,
    );
    txs.push(...remoteConfigTxs);

    return txs;
  }
}

/**
 * Sends one `SetRemoteConfig` tx per configured destination domain. There's
 * no "unenroll" concept — a stale RemoteConfig PDA for a since-removed
 * destination is harmless dead config, matching the on-chain program having
 * no delete instruction either.
 */
async function sendRemoteConfigInstructions(
  signer: SvmSigner,
  programAddress: Address,
  remoteConfigs: Record<number, CctpRemoteConfig> | undefined,
): Promise<SvmReceipt[]> {
  const receipts: SvmReceipt[] = [];
  const { address: tokenConfigPda } =
    await deriveHyperlaneTokenPda(programAddress);

  for (const [domainStr, remoteConfig] of Object.entries(remoteConfigs ?? {})) {
    const domain = Number(domainStr);
    assert(
      remoteConfig.maxFee !== undefined,
      `remoteConfigs[${domain}].maxFee is required for Sealevel CCTP routes`,
    );
    assert(
      remoteConfig.minFinalityThreshold !== undefined,
      `remoteConfigs[${domain}].minFinalityThreshold is required for Sealevel CCTP routes`,
    );
    const { address: remoteConfigPda } = await deriveCctpRemoteConfigPda(
      programAddress,
      domain,
    );
    const ixn = getCctpSetRemoteConfigInstruction(
      programAddress,
      tokenConfigPda,
      signer.signer.address,
      signer.signer.address,
      remoteConfigPda,
      {
        destinationDomain: domain,
        circleDomain: remoteConfig.circleDomain,
        maxFee: BigInt(remoteConfig.maxFee),
        minFinalityThreshold: remoteConfig.minFinalityThreshold,
      },
    );
    receipts.push(await signer.send({ instructions: [ixn] }));
  }

  return receipts;
}

/** Diffs current vs expected remoteConfigs and returns update txs for anything new/changed. */
async function computeCctpRemoteConfigUpdateInstructions(
  current: Record<number, CctpRemoteConfig>,
  expected: Record<number, CctpRemoteConfig>,
  programId: Address,
  ownerAddress: Address,
  label: string,
): Promise<AnnotatedSvmTransaction[]> {
  const txs: AnnotatedSvmTransaction[] = [];
  const { address: tokenConfigPda } = await deriveHyperlaneTokenPda(programId);

  for (const [domainStr, expectedConfig] of Object.entries(expected)) {
    const domain = Number(domainStr);
    const currentConfig = current[domain];
    const changed =
      !currentConfig ||
      currentConfig.circleDomain !== expectedConfig.circleDomain ||
      currentConfig.maxFee !== expectedConfig.maxFee ||
      currentConfig.minFinalityThreshold !==
        expectedConfig.minFinalityThreshold;

    if (!changed) continue;

    assert(
      expectedConfig.maxFee !== undefined,
      `remoteConfigs[${domain}].maxFee is required for Sealevel CCTP routes`,
    );
    assert(
      expectedConfig.minFinalityThreshold !== undefined,
      `remoteConfigs[${domain}].minFinalityThreshold is required for Sealevel CCTP routes`,
    );

    const { address: remoteConfigPda } = await deriveCctpRemoteConfigPda(
      programId,
      domain,
    );
    txs.push({
      feePayer: ownerAddress,
      instructions: [
        getCctpSetRemoteConfigInstruction(
          programId,
          tokenConfigPda,
          ownerAddress,
          ownerAddress,
          remoteConfigPda,
          {
            destinationDomain: domain,
            circleDomain: expectedConfig.circleDomain,
            maxFee: BigInt(expectedConfig.maxFee),
            minFinalityThreshold: expectedConfig.minFinalityThreshold,
          },
        ),
      ],
      annotation: `Update ${label}: set remote config for domain ${domain}`,
    });
  }

  return txs;
}

async function fetchCctpRemoteConfig(
  rpc: SvmRpc,
  programId: Address,
  domain: number,
): Promise<CctpRemoteConfig | undefined> {
  const { address: remoteConfigPda } = await deriveCctpRemoteConfigPda(
    programId,
    domain,
  );
  const account = await fetchEncodedAccount(rpc, remoteConfigPda);
  if (!account.exists) return undefined;
  const decoded = decodeCctpRemoteConfigAccount(Uint8Array.from(account.data));
  if (!decoded) return undefined;
  return {
    circleDomain: decoded.circleDomain,
    maxFee: decoded.maxFee.toString(),
    minFinalityThreshold: decoded.minFinalityThreshold,
  };
}
