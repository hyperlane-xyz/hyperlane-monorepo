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
  ): Promise<string> {
    const tx = await this.signer.getCreateNativeTokenTransaction({
      signer: this.signer.getSignerAddress(),
      mailboxAddress: artifact.config.mailbox,
    });
    const receipt = await this.signer.sendAndConfirmTransaction(tx);
    assert(
      receipt.contractAddress,
      'failed to deploy Starknet native warp token',
    );
    return receipt.contractAddress;
  }
}
