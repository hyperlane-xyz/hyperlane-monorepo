import {
  EvmHypCollateralFiatAdapter,
  EvmHypRebaseCollateralAdapter,
  EvmHypSyntheticAdapter,
  EvmHypSyntheticRebaseAdapter,
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  EvmMovableCollateralAdapter,
  EvmHypNativeAdapter,
} from './EvmTokenAdapter.js';
import { EvmHypCrossCollateralAdapter } from './EvmCrossCollateralAdapter.js';
import type { IHypTokenAdapter } from './ITokenAdapter.js';
import {
  hasChainMetadata,
  hasOnlyHyperlaneConnections,
  type HypTokenAdapterInput,
} from './hypTokenAdapterUtils.js';
import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '../../providers/ConfiguredMultiProtocolProvider.js';
import { TokenStandard } from '../TokenStandard.js';

export function createTronHypAdapter(
  multiProvider: MultiProtocolProvider<{ mailbox?: string }>,
  token: HypTokenAdapterInput,
): IHypTokenAdapter<unknown> | undefined {
  const { standard, chainName, addressOrDenom } = token;

  if (!standard || !hasChainMetadata(multiProvider, chainName)) {
    return undefined;
  }

  if (
    standard === TokenStandard.TronNative &&
    hasOnlyHyperlaneConnections(token)
  ) {
    return new EvmHypNativeAdapter(chainName, multiProvider, {
      token: addressOrDenom,
    });
  }

  switch (standard) {
    case TokenStandard.TronHypNative:
      return new EvmHypNativeAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.TronHypCollateral:
    case TokenStandard.TronHypOwnerCollateral:
      return new EvmMovableCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.TronHypCrossCollateralRouter:
      return new EvmHypCrossCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.TronHypRebaseCollateral:
      return new EvmHypRebaseCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.TronHypCollateralFiat:
      return new EvmHypCollateralFiatAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.TronHypSynthetic:
      return new EvmHypSyntheticAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.TronHypSyntheticRebase:
      return new EvmHypSyntheticRebaseAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.TronHypXERC20:
    case TokenStandard.TronHypVSXERC20:
      return new EvmHypXERC20Adapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.TronHypXERC20Lockbox:
    case TokenStandard.TronHypVSXERC20Lockbox:
      return new EvmHypXERC20LockboxAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    default:
      return undefined;
  }
}
