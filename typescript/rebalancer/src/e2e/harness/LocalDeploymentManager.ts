import type { DeployedAddresses } from '../fixtures/routes.js';
import type { LocalDeploymentContext as BaseLocalDeploymentContext } from './BaseLocalDeploymentManager.js';

export { BaseLocalDeploymentManager } from './BaseLocalDeploymentManager.js';
export { Erc20LocalDeploymentManager as LocalDeploymentManager } from './Erc20LocalDeploymentManager.js';
export type { LocalDeploymentContext as GenericLocalDeploymentContext } from './BaseLocalDeploymentManager.js';

export type LocalDeploymentContext =
  BaseLocalDeploymentContext<DeployedAddresses>;
