import { Environment } from '@abacus-network/deploy';
import { configs } from '../../networks/testnets';

export const environment: Environment = {
  domains: ['alfajores', 'kovan', 'mumbai', 'fuji'],
  transactionConfigs: configs,
};
