import type { Result } from '@ethersproject/abi';
import { BigNumber, ethers } from 'ethers';

import { ChainName } from '@hyperlane-xyz/sdk';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { awIcasLegacy } from '../../../config/environments/mainnet3/governance/ica/_awLegacy.js';
import { regularIcasLegacy } from '../../../config/environments/mainnet3/governance/ica/_regularLegacy.js';
import { Owner, determineGovernanceType } from '../../governance.js';
import { GovernanceType } from '../../governanceTypes.js';
export function formatFunctionFragmentArgs(
  args: Result,
  fragment: ethers.utils.FunctionFragment,
): Record<string, any> {
  const accumulator: Record<string, any> = {};
  return fragment.inputs.reduce((acc, input, index) => {
    acc[input.name] = args[index];
    return acc;
  }, accumulator);
}

export function formatDomain(
  getChainName: (domain: number) => string | undefined,
  domain: number | BigNumber,
): string {
  const domainNumber = BigNumber.isBigNumber(domain)
    ? domain.toNumber()
    : domain;
  const chainName = getChainName(domainNumber);
  return chainName ? `${domainNumber} (${chainName})` : `${domainNumber}`;
}

export async function getOwnerInsight(
  chain: ChainName,
  address: Address,
): Promise<string> {
  const { ownerType, governanceType } = await determineGovernanceType(
    chain,
    address,
  );
  if (ownerType !== Owner.UNKNOWN) {
    return `${address} (${governanceType.toUpperCase()} ${ownerType})`;
  }

  if (awIcasLegacy[chain] && eqAddress(address, awIcasLegacy[chain])) {
    return `${address} (${GovernanceType.AbacusWorks.toUpperCase()} ${Owner.ICA} LEGACY)`;
  }

  if (
    regularIcasLegacy[chain] &&
    eqAddress(address, regularIcasLegacy[chain])
  ) {
    return `${address} (${GovernanceType.Regular.toUpperCase()} ${Owner.ICA} LEGACY)`;
  }

  return `${address} (Unknown)`;
}
