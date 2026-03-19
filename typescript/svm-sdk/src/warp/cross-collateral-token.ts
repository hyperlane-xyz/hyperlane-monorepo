import { address as parseAddress, fetchEncodedAccount } from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  TokenType,
  type DeployedWarpAddress,
  type RawCrossCollateralWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { ZERO_ADDRESS_HEX_32, assert, isNullish } from '@hyperlane-xyz/utils';

import { decodeCrossCollateralStateAccount } from '../accounts/cross-collateral-token.js';
import { fetchMintMetadata } from '../accounts/mint.js';
import { decodeCollateralPlugin } from '../accounts/token.js';
import { deriveCrossCollateralStatePda } from '../pda.js';
import type { SvmRpc } from '../types.js';

import { fetchTokenAccount, routerBytesToHex } from './warp-query.js';
import { remoteDecimalsToScale } from './warp-tx.js';

export class SvmCrossCollateralTokenReader implements ArtifactReader<
  RawCrossCollateralWarpArtifactConfig,
  DeployedWarpAddress
> {
  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    programAddress: string,
  ): Promise<
    ArtifactDeployed<RawCrossCollateralWarpArtifactConfig, DeployedWarpAddress>
  > {
    const programId = parseAddress(programAddress);
    const token = await fetchTokenAccount(this.rpc, programId);
    assert(
      !isNullish(token),
      `Cross-collateral token not initialized at ${programId}`,
    );

    const plugin = decodeCollateralPlugin(token.pluginData);

    // Read CC state
    const { address: ccStatePdaAddr } =
      await deriveCrossCollateralStatePda(programId);
    const ccStateAccount = await fetchEncodedAccount(this.rpc, ccStatePdaAddr);
    assert(
      ccStateAccount.exists,
      `Cross-collateral state PDA not found at ${ccStatePdaAddr}`,
    );
    const ccState = decodeCrossCollateralStateAccount(
      ccStateAccount.data as Uint8Array,
    );
    assert(
      !isNullish(ccState),
      `Failed to decode cross-collateral state at ${ccStatePdaAddr}`,
    );

    // Build base remote routers
    const remoteRouters: Record<number, { address: string }> = {};
    for (const [domain, router] of token.remoteRouters.entries()) {
      remoteRouters[domain] = { address: routerBytesToHex(router) };
    }

    // Build destination gas
    const destinationGas: Record<number, string> = {};
    for (const [domain, gas] of token.destinationGas.entries()) {
      destinationGas[domain] = gas.toString();
    }

    // Build enrolled routers as Record<number, Set<string>>
    const crossCollateralRouters: Record<number, Set<string>> = {};
    for (const [domain, routerSet] of ccState.enrolledRouters.entries()) {
      crossCollateralRouters[domain] = new Set(routerSet.map(routerBytesToHex));
    }

    const metadata = await fetchMintMetadata(this.rpc, plugin.mint);

    assert(
      token.decimals === metadata.decimals,
      `Decimals mismatch for cross-collateral token ${programId}: ` +
        `warp route initialized with ${token.decimals} but mint reports ${metadata.decimals}`,
    );

    const config: RawCrossCollateralWarpArtifactConfig = {
      type: TokenType.crossCollateral,
      owner: token.owner ?? ZERO_ADDRESS_HEX_32,
      mailbox: token.mailbox,
      token: plugin.mint,
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: token.decimals,
      interchainSecurityModule: token.interchainSecurityModule
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: token.interchainSecurityModule },
          }
        : undefined,
      hook: token.interchainGasPaymaster
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: token.interchainGasPaymaster.programId },
          }
        : undefined,
      remoteRouters,
      destinationGas,
      scale: remoteDecimalsToScale(token.decimals, token.remoteDecimals),
      crossCollateralRouters,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: programId },
    };
  }
}
