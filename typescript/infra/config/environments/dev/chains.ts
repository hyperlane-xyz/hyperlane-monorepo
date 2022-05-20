import { chainConnectionConfigs } from '@abacus-network/sdk';

export const devConfigs = {
  alfajores: chainConnectionConfigs.alfajores,
  kovan: chainConnectionConfigs.kovan,
};

export type DevChains = keyof typeof devConfigs;
export const chainNames = Object.keys(devConfigs) as DevChains[];
