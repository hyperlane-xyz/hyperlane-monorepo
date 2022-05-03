import { CoreContractAddresses } from '../';
import { ChainName } from '../../';

import { addresses as test } from './test';

export const addresses: Record<
  any,
  Partial<Record<ChainName, CoreContractAddresses>>
> = {
  test,
};
