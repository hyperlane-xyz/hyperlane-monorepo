import { BigNumber } from 'ethers';
import { z } from 'zod';

import { InterchainGasPaymaster } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';
import { compareVersions } from 'compare-versions';
import type { Address } from '@hyperlane-xyz/utils';

import type { CheckerViolation } from '../deploy/types.js';
import {
  IgpSchema,
  IgpVersion,
  OFFCHAIN_QUOTED_IGP_VERSION,
} from '../hook/types.js';
import { ChainMap, ChainName } from '../types.js';

export type IgpConfig = z.infer<typeof IgpSchema>;

export function igpSupportsOffchainFeeQuoting({
  igpVersion,
  contractVersion,
  quoteSigners,
}: {
  igpVersion?: IgpVersion;
  contractVersion?: string;
  quoteSigners?: string[];
}): boolean {
  return (
    igpVersion !== IgpVersion.Legacy &&
    (quoteSigners !== undefined ||
      (contractVersion !== undefined &&
        compareVersions(contractVersion, OFFCHAIN_QUOTED_IGP_VERSION) >= 0))
  );
}

export function assertTokenOracleConfigHasNativeRemotes(
  chain: ChainName,
  config: Pick<IgpConfig, 'overhead' | 'tokenOracleConfig'>,
): void {
  if (!config.tokenOracleConfig) return;

  const configuredNativeRemotes = new Set(Object.keys(config.overhead));
  for (const [feeToken, oracleConfig] of Object.entries(
    config.tokenOracleConfig,
  )) {
    const missingNativeRemotes = Object.keys(oracleConfig).filter(
      (remote) => !configuredNativeRemotes.has(remote),
    );
    assert(
      missingNativeRemotes.length === 0,
      `Token gas oracle config for ${feeToken} on ${chain} includes remotes without native gas oracle config: ${missingNativeRemotes.join(
        ', ',
      )}`,
    );
  }
}

export enum IgpViolationType {
  Beneficiary = 'Beneficiary',
  GasOracles = 'GasOracles',
  Overhead = 'Overhead',
}

export interface IgpViolation extends CheckerViolation {
  type: 'InterchainGasPaymaster';
  subType: IgpViolationType;
}

export interface IgpBeneficiaryViolation extends IgpViolation {
  subType: IgpViolationType.Beneficiary;
  contract: InterchainGasPaymaster;
  actual: Address;
  expected: Address;
}

export interface IgpGasOraclesViolation extends IgpViolation {
  subType: IgpViolationType.GasOracles;
  contract: InterchainGasPaymaster;
  actual: ChainMap<Address>;
  expected: ChainMap<Address>;
}

export interface IgpOverheadViolation extends IgpViolation {
  subType: IgpViolationType.Overhead;
  contract: InterchainGasPaymaster;
  actual: ChainMap<BigNumber>;
  expected: ChainMap<BigNumber>;
}
