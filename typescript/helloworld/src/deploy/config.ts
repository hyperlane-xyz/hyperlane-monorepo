import { chainMetadata } from '@hyperlane-xyz/registry';
import { RouterConfig } from '@hyperlane-xyz/sdk';

import { MailboxAddress } from '../../../sdk/src/router/types.js';

export type HelloWorldConfig = RouterConfig & MailboxAddress;

// SET DESIRED NETWORKS HERE OR USE THE DEFAULT SET FROM THE REGISTRY
export const prodConfigs = {
  ...chainMetadata,
};
