import { z } from 'zod';

import {
  CoreDeploymentPlan,
  DeployedCoreAddresses,
  DeployedCoreAddressesSchema,
} from '@hyperlane-xyz/sdk';

import { logBlue, logGreen } from '../logger.js';

/**
 * Creates a deployment plan based on required and existing contracts
 */
export function createCoreDeploymentPlan(
  existingAddresses: DeployedCoreAddresses | undefined,
  fix: boolean,
): CoreDeploymentPlan {
  // Get required fields from the schema (those that are z.string() without .optional())
  const requiredContracts = Object.entries(DeployedCoreAddressesSchema.shape)
    .filter(
      ([_, schema]) => schema instanceof z.ZodString && !schema.isOptional(),
    )
    .map(([key]) => key) as Array<keyof DeployedCoreAddresses>;

  if (!existingAddresses) {
    // If no existing addresses, deploy everything
    return Object.fromEntries(
      requiredContracts.map((contract) => [contract, true]),
    ) as CoreDeploymentPlan;
  }

  const missingContracts = requiredContracts.filter(
    (contract) => !existingAddresses[contract],
  );

  if (fix && missingContracts.length === 0) {
    logGreen('All core contracts already deployed, nothing to do');
    process.exit(0);
  }

  if (fix) {
    logBlue(
      `Found existing core contracts, will deploy missing ones: ${missingContracts.join(
        ', ',
      )}`,
    );
  }

  // Create a deployment plan indicating which contracts need to be deployed
  return Object.fromEntries(
    requiredContracts.map((contract) => [
      contract,
      !existingAddresses[contract], // true means needs deployment
    ]),
  ) as CoreDeploymentPlan;
}
