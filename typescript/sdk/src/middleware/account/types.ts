import { z } from 'zod';

import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types.js';

import { GetCallRemoteSettingsSchema } from './schemas.js';

export type AccountConfig = {
  origin: ChainName;
  owner: Address;
  localRouter?: Address;
  routerOverride?: Address;
  ismOverride?: Address;
};

/* For InterchainAccount::getCallRemote() */
export type GetCallRemoteSettings = z.infer<typeof GetCallRemoteSettingsSchema>;
