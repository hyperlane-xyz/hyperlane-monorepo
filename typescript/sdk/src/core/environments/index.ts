import { CoreContractAddresses } from '../';
import { ChainName } from '../../';

import { addresses as test } from './test';
import { addresses as testnet } from './testnet';

export const addresses: Record<
  any,
  Partial<Record<ChainName, CoreContractAddresses>>
> = {
  test,
  testnet,
};
