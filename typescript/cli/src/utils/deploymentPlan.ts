import { z } from 'zod';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  DeployedCoreAddresses,
  ProxyFactoryFactoriesAddresses,
  ProxyFactoryFactoriesSchema,
} from '@hyperlane-xyz/sdk';

import { logGreen } from '../logger.js';

export type FactoryDeployPlan = Record<
  keyof ProxyFactoryFactoriesAddresses,
  boolean
>;

/**
 * Creates a deployment plan for proxy factories based on existing deployments
 */
export function planFactoryDeployments(
  existingAddresses: ChainAddresses,
): FactoryDeployPlan {
  // Get required fields from the schema (those that are z.string() without .optional())
  const requiredFactories = Object.entries(ProxyFactoryFactoriesSchema.shape)
    .filter(
      ([_, schema]) => schema instanceof z.ZodString && !schema.isOptional(),
    )
    .map(([key]) => key) as Array<keyof DeployedCoreAddresses>;

  if (!existingAddresses) {
    // If no existing addresses, deploy everything
    return Object.fromEntries(
      requiredFactories.map((factory) => [factory, true]),
    ) as FactoryDeployPlan;
  }

  const missingFactories = requiredFactories.filter(
    (factory) => !existingAddresses[factory],
  );

  if (missingFactories.length === 0) {
    logGreen('All core factories already deployed, nothing to do');
    process.exit(0);
  }

  // Create a deployment plan indicating which factories need to be deployed
  return Object.fromEntries(
    requiredFactories.map((factory) => [
      factory,
      !existingAddresses[factory], // true means needs deployment
    ]),
  ) as FactoryDeployPlan;
}
