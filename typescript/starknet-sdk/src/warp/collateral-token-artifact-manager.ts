import { type ArtifactNew } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  TokenType,
  type RawWarpArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, eqAddressStarknet } from '@hyperlane-xyz/utils';

import { normalizeStarknetAddressSafe } from '../contracts.js';

import {
  type StarknetRemoteRoutersOnChain,
  type StarknetWarpTokenOnChain,
  StarknetWarpTokenReaderBase,
  StarknetWarpTokenWriterBase,
} from './token-artifact-manager.js';

export class StarknetCollateralTokenReader extends StarknetWarpTokenReaderBase<
  'collateral',
  RawWarpArtifactConfigs['collateral']
> {
  protected readonly tokenType = 'collateral' as const;

  protected toConfig(
    token: StarknetWarpTokenOnChain,
    remoteRouters: StarknetRemoteRoutersOnChain,
  ): RawWarpArtifactConfigs['collateral'] {
    return {
      type: TokenType.collateral,
      ...this.baseConfig(token, remoteRouters),
      token: normalizeStarknetAddressSafe(token.denom),
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
    };
  }
}

export class StarknetCollateralTokenWriter extends StarknetWarpTokenWriterBase<
  'collateral',
  RawWarpArtifactConfigs['collateral']
> {
  protected readonly tokenType = 'collateral' as const;

  protected toConfig(
    token: StarknetWarpTokenOnChain,
    remoteRouters: StarknetRemoteRoutersOnChain,
  ): RawWarpArtifactConfigs['collateral'] {
    return {
      type: TokenType.collateral,
      ...this.baseConfig(token, remoteRouters),
      token: normalizeStarknetAddressSafe(token.denom),
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
    };
  }

  protected async createToken(
    artifact: ArtifactNew<RawWarpArtifactConfigs['collateral']>,
  ): Promise<string> {
    const tx = await this.signer.getCreateCollateralTokenTransaction({
      signer: this.signer.getSignerAddress(),
      mailboxAddress: artifact.config.mailbox,
      collateralDenom: artifact.config.token,
    });
    const receipt = await this.signer.sendAndConfirmTransaction(tx);
    assert(
      receipt.contractAddress,
      'failed to deploy Starknet collateral warp token',
    );
    return receipt.contractAddress;
  }

  protected override validateUpdateConfig(
    current: RawWarpArtifactConfigs['collateral'],
    expected: RawWarpArtifactConfigs['collateral'],
  ): void {
    super.validateUpdateConfig(current, expected);
    assert(
      eqAddressStarknet(current.token, expected.token),
      `Cannot change Starknet collateral token from ${current.token} to ${expected.token}`,
    );
  }
}
