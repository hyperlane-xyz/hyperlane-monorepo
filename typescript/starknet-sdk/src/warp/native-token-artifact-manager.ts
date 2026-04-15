import { type ArtifactNew } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  TokenType,
  type RawWarpArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/warp';

import {
  type StarknetRemoteRoutersOnChain,
  type StarknetWarpTokenOnChain,
  StarknetWarpTokenReaderBase,
  StarknetWarpTokenWriterBase,
} from './token-artifact-manager.js';
import { getCreateNativeTokenTx } from './warp-tx.js';

export class StarknetNativeTokenReader extends StarknetWarpTokenReaderBase<
  'native',
  RawWarpArtifactConfigs['native']
> {
  protected readonly tokenType = 'native' as const;

  protected toConfig(
    token: StarknetWarpTokenOnChain,
    remoteRouters: StarknetRemoteRoutersOnChain,
  ): RawWarpArtifactConfigs['native'] {
    return {
      type: TokenType.native,
      ...this.baseConfig(token, remoteRouters),
    };
  }
}

export class StarknetNativeTokenWriter extends StarknetWarpTokenWriterBase<
  'native',
  RawWarpArtifactConfigs['native']
> {
  protected readonly tokenType = 'native' as const;

  protected toConfig(
    token: StarknetWarpTokenOnChain,
    remoteRouters: StarknetRemoteRoutersOnChain,
  ): RawWarpArtifactConfigs['native'] {
    return {
      type: TokenType.native,
      ...this.baseConfig(token, remoteRouters),
    };
  }

  protected async createToken(
    artifact: ArtifactNew<RawWarpArtifactConfigs['native']>,
  ) {
    const mailbox = await this.provider.getMailbox({
      mailboxAddress: artifact.config.mailbox,
    });
    const tx = getCreateNativeTokenTx(
      {
        signer: this.signer.getSignerAddress(),
        mailboxAddress: artifact.config.mailbox,
      },
      {
        defaultHook: mailbox.defaultHook,
        defaultIsm: mailbox.defaultIsm,
      },
      this.provider.getFeeTokenAddress(),
    );
    return this.signer.sendAndConfirmTransaction(tx);
  }
}
