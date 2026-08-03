import { type ForkManagerFactory } from '@hyperlane-xyz/forking-sdk';
import type * as SvmFork from '@hyperlane-xyz/sealevel-sdk/fork';

type SvmForkModule = typeof SvmFork;

export function createSvmForkManagerFactory(
  svmFork: SvmForkModule,
  kill: boolean,
): ForkManagerFactory {
  return (ctx) =>
    svmFork.createSvmForkManager({
      chainName: ctx.chainName,
      upstreamRpcUrl: ctx.upstreamRpcUrl,
      rpcPort: ctx.port,
      killAfterApply: kill,
    });
}
