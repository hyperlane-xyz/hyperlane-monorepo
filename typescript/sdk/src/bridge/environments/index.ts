import { addresses as test } from './test';
import { ChainName } from '../../';
import { BridgeContractAddresses } from '../';
export const addresses: Record<
  any,
  Partial<Record<ChainName, BridgeContractAddresses>>
> = {
  test,
};
