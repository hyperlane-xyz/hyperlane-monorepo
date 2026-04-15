import { type ArtifactNew } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  TokenType,
  type RawWarpArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert } from '@hyperlane-xyz/utils';

import {
  type StarknetRemoteRoutersOnChain,
  type StarknetWarpTokenOnChain,
  StarknetWarpTokenReaderBase,
  StarknetWarpTokenWriterBase,
} from './token-artifact-manager.js';
import { getCreateSyntheticTokenTx } from './warp-tx.js';

export class StarknetSyntheticTokenReader extends StarknetWarpTokenReaderBase<
  'synthetic',
  RawWarpArtifactConfigs['synthetic']
> {
  protected readonly tokenType = 'synthetic' as const;

  protected toConfig(
    token: StarknetWarpTokenOnChain,
    remoteRouters: StarknetRemoteRoutersOnChain,
  ): RawWarpArtifactConfigs['synthetic'] {
    return {
      type: TokenType.synthetic,
      ...this.baseConfig(token, remoteRouters),
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
    };
  }
}

export class StarknetSyntheticTokenWriter extends StarknetWarpTokenWriterBase<
  'synthetic',
  RawWarpArtifactConfigs['synthetic']
> {
  protected readonly tokenType = 'synthetic' as const;

  protected toConfig(
    token: StarknetWarpTokenOnChain,
    remoteRouters: StarknetRemoteRoutersOnChain,
  ): RawWarpArtifactConfigs['synthetic'] {
    return {
      type: TokenType.synthetic,
      ...this.baseConfig(token, remoteRouters),
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
    };
  }

  protected override validateCreateConfig(
    config: RawWarpArtifactConfigs['synthetic'],
  ): void {
    super.validateCreateConfig(config);
    assert(
      !config.metadataUri,
      'metadataUri is unsupported for Starknet synthetic warp tokens',
    );
  }

  protected override validateUpdateConfig(
    current: RawWarpArtifactConfigs['synthetic'],
    expected: RawWarpArtifactConfigs['synthetic'],
  ): void {
    super.validateUpdateConfig(current, expected);
    assert(
      current.name === expected.name,
      `Cannot change Starknet synthetic token name from ${current.name} to ${expected.name}`,
    );
    assert(
      current.symbol === expected.symbol,
      `Cannot change Starknet synthetic token symbol from ${current.symbol} to ${expected.symbol}`,
    );
    assert(
      current.decimals === expected.decimals,
      `Cannot change Starknet synthetic token decimals from ${current.decimals} to ${expected.decimals}`,
    );
    assert(
      !expected.metadataUri,
      'metadataUri is unsupported for Starknet synthetic warp tokens',
    );
  }

  protected async createToken(
    artifact: ArtifactNew<RawWarpArtifactConfigs['synthetic']>,
  ) {
    const mailbox = await this.provider.getMailbox({
      mailboxAddress: artifact.config.mailbox,
    });
    const tx = getCreateSyntheticTokenTx(
      {
        signer: this.signer.getSignerAddress(),
        mailboxAddress: artifact.config.mailbox,
        name: artifact.config.name,
        denom: artifact.config.symbol,
        decimals: artifact.config.decimals,
      },
      {
        defaultHook: mailbox.defaultHook,
        defaultIsm: mailbox.defaultIsm,
      },
    );
    return this.signer.sendAndConfirmTransaction(tx);
  }
}
