import { constants, utils } from 'ethers';
import { z } from 'zod';

import {
  ChainTechnicalStack,
  type ChainMap,
  type ChainName,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';
import { readYaml } from '@hyperlane-xyz/utils/fs';

import { isStandardEvm } from '../aggregation-hook-upgrade/protocol.js';

import type { FeeToken } from './types.js';

// A YAML scalar like 0xabc... that is not quoted is read as a number, which the
// schema rejects instead of silently truncating the address.
const FeeTokensFileSchema = z.record(
  z.string(),
  z.array(
    z.strictObject({
      symbol: z.string().min(1),
      address: z.string(),
    }),
  ),
);

// The file may cover more chains than the run targets. Every entry is checked,
// but a chain without one has no fee tokens and only native fees work from it.
export function loadFeeTokens(
  path: string,
  chains: ChainName[],
): ChainMap<FeeToken[]> {
  const parsed = FeeTokensFileSchema.safeParse(readYaml<unknown>(path));
  const problems = parsed.success
    ? ''
    : parsed.error.issues
        .map((issue) =>
          issue.path.length === 0
            ? issue.message
            : `${issue.path.join('.')}: ${issue.message}`,
        )
        .join('; ');
  assert(
    parsed.success,
    `${path} must map each chain to a list of { symbol, address } fee tokens with the address quoted: ${problems}`,
  );

  const fileTokens: ChainMap<FeeToken[]> = {};
  for (const [chain, tokens] of Object.entries(parsed.data)) {
    fileTokens[chain] = tokens.map(({ symbol, address }) => {
      assert(
        utils.isAddress(address),
        `${path}: the ${symbol} fee token on ${chain} is not a valid EVM address`,
      );
      const checksummed = utils.getAddress(address);
      assert(
        checksummed !== constants.AddressZero,
        `${path}: the ${symbol} fee token on ${chain} must not be the zero address`,
      );
      return { symbol, address: checksummed };
    });
  }

  const feeTokens: ChainMap<FeeToken[]> = {};
  for (const chain of chains) {
    feeTokens[chain] = fileTokens[chain] ?? [];
  }
  return feeTokens;
}

export interface ChainSupport {
  protocol: ProtocolType;
  technicalStack?: ChainTechnicalStack;
  hasMailbox: boolean;
}

// The ICA router and QuotedCalls are EVM contracts and the router is built
// around the chain's registered mailbox, so any other chain is refused before
// anything is read.
export function assertDeployableChains(
  chains: ChainName[],
  support: (chain: ChainName) => ChainSupport,
): void {
  for (const chain of chains) {
    const { protocol, technicalStack, hasMailbox } = support(chain);
    assert(
      isStandardEvm(protocol),
      `${chain} uses protocol ${protocol}: only standard EVM chains are supported`,
    );
    assert(
      technicalStack !== ChainTechnicalStack.ZkSync,
      `${chain} uses zkSync: this deployment script does not support zkSync artifacts or deployment addresses`,
    );
    assert(hasMailbox, `${chain} has no mailbox in the registry`);
  }
}
