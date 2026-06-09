import {
  type ArtifactNew,
  ArtifactComposition,
  type WithCompositionVariant,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  TokenType,
  type RawWarpArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/warp';

import { getMailboxConfig } from '../mailbox/mailbox-query.js';

import {
  type StarknetRemoteRoutersOnChain,
  type StarknetWarpTokenOnChain,
  StarknetWarpTokenReaderBase,
  StarknetWarpTokenWriterBase,
} from './token-artifact-manager.js';
import { getCreateNativeTokenTx } from './warp-tx.js';

type OrchestratedNativeConfig = WithCompositionVariant<
  RawWarpArtifactConfigs['native'],
  typeof ArtifactComposition.ORCHESTRATED
>;

export class StarknetNativeTokenReader extends StarknetWarpTokenReaderBase<
  'native',
  RawWarpArtifactConfigs['native']
> {
  protected readonly tokenType = 'native' as const;

  protected toConfig(
    token: StarknetWarpTokenOnChain,
    remoteRouters: StarknetRemoteRoutersOnChain,
  ): OrchestratedNativeConfig {
    return {
      composition: ArtifactComposition.ORCHESTRATED,
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
  ): OrchestratedNativeConfig {
    return {
      composition: ArtifactComposition.ORCHESTRATED,
      type: TokenType.native,
      ...this.baseConfig(token, remoteRouters),
    };
  }

  protected async createToken(artifact: ArtifactNew<OrchestratedNativeConfig>) {
    const mailbox = await getMailboxConfig(
      this.provider.getRawProvider(),
      artifact.config.mailbox,
    );
    const tx = getCreateNativeTokenTx(this.signer.getSignerAddress(), {
      mailboxAddress: artifact.config.mailbox,
      feeTokenAddress: this.provider.getFeeTokenAddress(),
      defaultHook: mailbox.defaultHook,
      defaultIsm: mailbox.defaultIsm,
    });
    return this.signer.sendAndConfirmTransaction(tx);
  }
}
