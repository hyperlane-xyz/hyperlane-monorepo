import { ChainName, GovernanceContractAddresses } from '../../';

import { addresses as test } from './test';

export const addresses: Record<
  any,
  Partial<Record<ChainName, GovernanceContractAddresses>>
> = {
  test,
};
