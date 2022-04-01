import { addresses as test } from './test';
import { ChainName, GovernanceContractAddresses } from '../../';
export const addresses: Record<
  any,
  Partial<Record<ChainName, GovernanceContractAddresses>>
> = {
  test,
};
