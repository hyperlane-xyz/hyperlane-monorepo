import { chainMetadata } from '@hyperlane-xyz/registry';
import { MailboxAddress, RouterConfig } from '@hyperlane-xyz/sdk';

export type HelloWorldConfig = RouterConfig & MailboxAddress;

// SET DESIRED NETWORKS HERE OR USE THE DEFAULT SET FROM THE REGISTRY
export const prodConfigs = {
  ...chainMetadata,
};
