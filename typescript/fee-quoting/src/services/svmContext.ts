import type { Logger } from 'pino';

import {
  type ChainMetadataForAltVM,
  ProtocolType,
  getProtocolProvider,
  hasProtocol,
  registerProtocol,
} from '@hyperlane-xyz/provider-sdk';
import {
  SealevelProtocolProvider,
  isSealevelDeployedIgpHook,
  isSealevelDeployedWarpAddress,
} from '@hyperlane-xyz/sealevel-sdk';

import type {
  SvmFeeQuoterContext,
  SvmIgpQuoterContext,
  SvmRouterQuoteContext,
} from './quoteService.js';

/**
 * Ensure the Sealevel protocol provider is registered with the provider-sdk
 * registry. Idempotent. Called once at startup before any SVM context build.
 */
export function ensureSealevelProtocolRegistered(): void {
  if (!hasProtocol(ProtocolType.Sealevel)) {
    registerProtocol(
      ProtocolType.Sealevel,
      () => new SealevelProtocolProvider(),
    );
  }
}

/**
 * Reads on-chain SVM state for a single warp router and assembles the
 * `SvmRouterQuoteContext` the signer (Phase 5) will consume. RPC client and
 * salt management are delegated to the protocol provider's artifact managers;
 * fee/IGP sub-contexts are populated best-effort so a route can be registered
 * even when only some quoters are configured.
 */
export async function buildSvmRouterContext(args: {
  chainName: string;
  domainId: number;
  metadata: ChainMetadataForAltVM;
  warpProgramId: string;
  logger: Logger;
}): Promise<SvmRouterQuoteContext> {
  const { chainName, domainId, metadata, warpProgramId, logger } = args;

  ensureSealevelProtocolRegistered();
  const provider = getProtocolProvider(ProtocolType.Sealevel);

  const warpManager = provider.createWarpArtifactManager(metadata);
  const warpArtifact = await warpManager.readWarpToken(warpProgramId);

  // The SVM warp reader stores the on-chain `feeConfig` (program ID + fee
  // account PDA) on its deployed shape; read it directly rather than doing
  // a second fee-artifact lookup.
  const fee = isSealevelDeployedWarpAddress(warpArtifact.deployed)
    ? extractSvmFeeContext(warpArtifact.deployed.feeConfig)
    : undefined;

  const hookProgramId = warpArtifact.config.hook?.deployed.address;
  const igp = hookProgramId
    ? await tryReadIgp({ chainName, metadata, hookProgramId, logger })
    : undefined;

  return {
    protocol: ProtocolType.Sealevel,
    domainId,
    warpProgramId,
    fee,
    igp,
  };
}

function extractSvmFeeContext(
  feeConfig: { feeProgram: string; feeAccount: string } | undefined,
): SvmFeeQuoterContext | undefined {
  if (!feeConfig) return undefined;
  return {
    programId: feeConfig.feeProgram,
    feeAccountPda: feeConfig.feeAccount,
  };
}

async function tryReadIgp(args: {
  chainName: string;
  metadata: ChainMetadataForAltVM;
  hookProgramId: string;
  logger: Logger;
}): Promise<SvmIgpQuoterContext | undefined> {
  const { chainName, metadata, hookProgramId, logger } = args;

  const provider = getProtocolProvider(ProtocolType.Sealevel);
  const hookManager = provider.createHookArtifactManager(metadata);

  try {
    const artifact = await hookManager.readHook(hookProgramId);
    if (!isSealevelDeployedIgpHook(artifact.deployed)) {
      logger.debug(
        { chainName, hookProgramId },
        'SVM hook is not an IGP — skipping IGP quoter for this route',
      );
      return undefined;
    }
    return {
      programId: hookProgramId,
      igpAccountPda: artifact.deployed.igpPda,
    };
  } catch (err) {
    logger.warn(
      { chainName, hookProgramId, err },
      'Failed to read SVM IGP artifact — skipping IGP quoter for this route',
    );
    return undefined;
  }
}
