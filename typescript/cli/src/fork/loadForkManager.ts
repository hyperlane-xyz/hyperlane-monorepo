import { type ForkManagerRegistry } from '@hyperlane-xyz/forking-sdk';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  type MultiProvider,
  RawForkedChainConfigByChainSchema,
  forkedChainConfigByChainFromRaw,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

export type ForkConfigParser = (
  rawSubset: Record<string, unknown>,
) => Record<string, unknown>;

interface LoadForkManagerArgs {
  registry: ForkManagerRegistry;
  parsers: Map<ProtocolType, ForkConfigParser>;
  multiProvider: MultiProvider;
  fileReader: <T>(path: string) => T;
}

/**
 * Dynamically loads and registers the fork manager (and its fork-config parser)
 * for a single protocol. Protocols without a fork manager are left unregistered
 * so the caller's chain gate skips them.
 */
export async function loadForkManager(
  protocol: ProtocolType,
  { registry, parsers, multiProvider, fileReader }: LoadForkManagerArgs,
): Promise<void> {
  if (registry.hasProtocol(protocol)) {
    return;
  }

  switch (protocol) {
    case ProtocolType.Ethereum: {
      const { createEvmForkManagerFactory } =
        await import('./EvmForkManager.js');
      registry.registerProtocol(
        protocol,
        createEvmForkManagerFactory(multiProvider),
      );
      parsers.set(protocol, (rawSubset) =>
        forkedChainConfigByChainFromRaw(
          RawForkedChainConfigByChainSchema.parse(rawSubset),
          fileReader,
        ),
      );
      break;
    }
    case ProtocolType.Sealevel: {
      const { createSvmForkManager, parseSvmForkConfig } =
        await import('@hyperlane-xyz/sealevel-sdk/fork');
      registry.registerProtocol(protocol, (ctx) =>
        createSvmForkManager({
          chainName: ctx.chainName,
          upstreamRpcUrl: ctx.upstreamRpcUrl,
          rpcPort: ctx.port,
          wsPort: ctx.wsPort,
        }),
      );
      parsers.set(protocol, (rawSubset) =>
        objMap(rawSubset, (_chain, slice) =>
          parseSvmForkConfig(slice, fileReader),
        ),
      );
      break;
    }
  }
}
