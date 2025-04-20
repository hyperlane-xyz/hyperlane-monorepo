import { Argv } from 'yargs';

import { ChainName } from '@hyperlane-xyz/sdk';
import { Address, eqAddressEvm } from '@hyperlane-xyz/utils';

import {
  getGovernanceIcas,
  getGovernanceSafes,
} from '../config/environments/mainnet3/governance/utils.js';

import { DeployEnvironment } from './config/environment.js';

export enum GovernanceType {
  AbacusWorks = 'abacusWorks',
  Regular = 'regular',
  Irregular = 'irregular',
}

export enum Owner {
  ICA = 'ICA',
  SAFE = 'SAFE',
  DEPLOYER = 'DEPLOYER KEY',
  UNKNOWN = 'UNKNOWN',
}

export const DEPLOYERS: Record<DeployEnvironment, Address> = {
  mainnet3: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
  testnet4: '0xfaD1C94469700833717Fa8a3017278BC1cA8031C',
  test: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
};

export function withGovernanceType<T>(args: Argv<T>) {
  return args.option('governanceType', {
    type: 'string',
    description: 'Type of governance to use',
    choices: Object.values(GovernanceType),
    default: GovernanceType.Regular,
  });
}

export async function determineGovernanceType(
  chain: ChainName,
  address: Address,
): Promise<{
  ownerType: Owner | null;
  governanceType: GovernanceType;
}> {
  if (
    Object.values(DEPLOYERS).some((deployer) => eqAddressEvm(deployer, address))
  ) {
    return {
      ownerType: Owner.DEPLOYER,
      governanceType: GovernanceType.AbacusWorks,
    };
  }

  for (const governanceType of Object.values(GovernanceType)) {
    const icas = getGovernanceIcas(governanceType);
    if (icas[chain] && icas[chain].includes(address)) {
      return { ownerType: Owner.ICA, governanceType };
    }
    const safes = getGovernanceSafes(governanceType);
    if (safes[chain] && safes[chain].includes(address)) {
      return { ownerType: Owner.SAFE, governanceType };
    }
  }

  return {
    ownerType: Owner.UNKNOWN,
    governanceType: GovernanceType.AbacusWorks,
  };
}
