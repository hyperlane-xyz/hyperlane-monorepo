import * as sdk from '@provablehq/sdk/mainnet.js';

import { AleoNetworkId } from '../constants.js';

import { createAleoProviderClass } from './provider.js';

export const AleoProvider = createAleoProviderClass(sdk, AleoNetworkId.MAINNET);
export type AleoProvider = InstanceType<typeof AleoProvider>;
