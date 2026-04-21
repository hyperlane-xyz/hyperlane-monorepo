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
import { getCreateCollateralTokenTx } from './warp-tx.js';
import { getMailboxConfig } from '../mailbox/mailbox-query.js';

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
  ) {
    const mailbox = await getMailboxConfig(
      this.provider.getRawProvider(),
      artifact.config.mailbox,
    );
    const tx = getCreateCollateralTokenTx(this.signer.getSignerAddress(), {
      mailboxAddress: artifact.config.mailbox,
      collateralDenom: artifact.config.token,
      defaultHook: mailbox.defaultHook,
      defaultIsm: mailbox.defaultIsm,
    });
    return this.signer.sendAndConfirmTransaction(tx);
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
