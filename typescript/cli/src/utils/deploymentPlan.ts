import { ChainAddresses } from '@hyperlane-xyz/registry';
import { ProxyFactoryFactoriesSchema } from '@hyperlane-xyz/sdk';

import { logGreen } from '../logger.js';

/**
 * Creates a deployment plan for proxy factories based on existing deployments
 */
export function planFactoryDeployments(
  existingAddresses: ChainAddresses,
): Record<string, boolean> {
  // Get required factories from the schema (those that are z.string() without .optional())
  const requiredFactories = Object.entries(ProxyFactoryFactoriesSchema.shape)
    .filter(([_, schema]) => schema && !schema.isOptional())
    .map(([key]) => key);

  if (!existingAddresses) {
    // If no existing addresses, deploy everything
    return Object.fromEntries(
      requiredFactories.map((factory) => [factory, true]),
    );
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
  );
}
