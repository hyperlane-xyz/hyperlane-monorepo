import type { ChainName } from '../types';

export interface CheckerViolation {
  chain: ChainName;
  type: string;
  expected: any;
  actual: any;
  data?: any;
}
