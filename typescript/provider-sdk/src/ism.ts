import { WithAddress, deepEquals } from '@hyperlane-xyz/utils';

export type IsmModuleType = {
  config: IsmConfig;
  derived: DerivedIsmConfig;
  addresses: IsmModuleAddresses;
};

export interface IsmConfigs {
  domainRoutingIsm: DomainRoutingIsmConfig;
  merkleRootMultisigIsm: MultisigIsmConfig;
  messageIdMultisigIsm: MultisigIsmConfig;
  testIsm: TestIsmConfig;
}

export type IsmType = keyof IsmConfigs;
export type IsmConfig = IsmConfigs[IsmType];
export type DerivedIsmConfig = WithAddress<IsmConfig>;

export const STATIC_ISM_TYPES: IsmType[] = [
  'merkleRootMultisigIsm',
  'messageIdMultisigIsm',
];

export interface MultisigIsmConfig {
  type: 'merkleRootMultisigIsm' | 'messageIdMultisigIsm';
  validators: string[];
  threshold: number;
}

export interface TestIsmConfig {
  type: 'testIsm';
}

export interface DomainRoutingIsmConfig {
  type: 'domainRoutingIsm';
  owner: string;
  domains: Record<string, IsmConfig | string>;
}

export type IsmModuleAddresses = {
  deployedIsm: string;
  mailbox: string;
};

/**
 * Calculates the routing delta between the current and target routing ISM configurations
 * Returns the domains that need to be enrolled or unenrolled
 */
export function calculateDomainRoutingIsmDelta(
  current: DomainRoutingIsmConfig,
  target: DomainRoutingIsmConfig,
): {
  domainsToEnroll: string[];
  domainsToUnenroll: string[];
} {
  const domainsToEnroll: string[] = [];
  for (const domain of Object.keys(target.domains)) {
    const currentIsmConfig = current.domains[domain];
    const targetIsmConfig = target.domains[domain];

    if (!currentIsmConfig) {
      domainsToEnroll.push(domain);
    } else {
      const subModuleMatches = deepEquals(currentIsmConfig, targetIsmConfig);
      if (!subModuleMatches) {
        domainsToEnroll.push(domain);
      }
    }
  }

  const domainsToUnenroll = Object.keys(current.domains).filter(
    (domain) => !Object.keys(target.domains).includes(domain),
  );

  return {
    domainsToEnroll,
    domainsToUnenroll,
  };
}

/**
 * Extracts the ISM address from a domain config
 */
export function extractIsmAddress(
  domainConfig: string | DerivedIsmConfig,
): string {
  if (typeof domainConfig === 'string') {
    return domainConfig;
  }
  return domainConfig.address;
}
