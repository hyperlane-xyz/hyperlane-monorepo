import { confirm } from '@inquirer/prompts';

import { pollAsync } from '@hyperlane-xyz/utils';

import { HelmManager } from './helm.js';
import { execCmd } from './utils.js';

export enum K8sResourceType {
  SECRET = 'secret',
  POD = 'pod',
}

export async function refreshK8sResources(
  helmManagers: HelmManager<any>[],
  resourceType: K8sResourceType,
  namespace: string,
) {
  const resourceNames = (
    await Promise.all(
      helmManagers.map(async (helmManager) => {
        if (resourceType === K8sResourceType.SECRET) {
          return helmManager.getExistingK8sSecrets();
        } else if (resourceType === K8sResourceType.POD) {
          return helmManager.getManagedK8sPods();
        } else {
          throw new Error(`Unknown resource type: ${resourceType}`);
        }
      }),
    )
  ).flat();

  console.log(`Ready to delete ${resourceType}s: ${resourceNames.join(', ')}`);

  const cont = await confirm({
    message: `Proceed and delete ${resourceNames.length} ${resourceType}s?`,
  });
  if (!cont) {
    throw new Error('Aborting');
  }

  await execCmd(
    `kubectl delete ${resourceType} ${resourceNames.join(' ')} -n ${namespace}`,
  );
  console.log(
    `🏗  Deleted ${resourceNames.length} ${resourceType}s, waiting for them to be recreated...`,
  );

  await waitForK8sResources(resourceType, resourceNames, namespace);
}

// Polls until all resources are ready.
// For secrets, this means they exist.
// For pods, this means they exist and are running.
async function waitForK8sResources(
  resourceType: K8sResourceType,
  resourceNames: string[],
  namespace: string,
) {
  const resourceGetter =
    resourceType === K8sResourceType.SECRET
      ? getExistingK8sSecrets
      : getRunningK8sPods;

  try {
    const pollDelayMs = 2000;
    const pollAttempts = 30;
    await pollAsync(
      async () => {
        const { missing } = await resourceGetter(resourceNames, namespace);
        if (missing.length > 0) {
          console.log(
            `⏳ ${resourceNames.length - missing.length} of ${
              resourceNames.length
            } ${resourceType}s up, waiting for ${missing.length} more`,
          );
          throw new Error(
            `${resourceType}s not ready, ${missing.length} missing`,
          );
        }
      },
      pollDelayMs,
      pollAttempts,
    );
    console.log(`✅  All ${resourceNames.length} ${resourceType}s exist`);
  } catch (e) {
    console.error(`Error waiting for ${resourceType}s to exist: ${e}`);
  }
}

async function getExistingK8sSecrets(
  resourceNames: string[],
  namespace: string,
): Promise<{
  existing: string[];
  missing: string[];
}> {
  const [output] = await execCmd(
    `kubectl get secret ${resourceNames.join(
      ' ',
    )} -n ${namespace} --ignore-not-found -o jsonpath='{.items[*].metadata.name}'`,
  );
  const existing = output.split(' ').filter(Boolean);
  const missing = resourceNames.filter(
    (resource) => !existing.includes(resource),
  );
  return { existing, missing };
}

async function getRunningK8sPods(
  resourceNames: string[],
  namespace: string,
): Promise<{
  existing: string[];
  missing: string[];
}> {
  // Returns a newline separated list of pod names and their statuses, e.g.:
  //   pod1:Running
  //   pod2:Pending
  //   pod3:Running
  // Interestingly, providing names here is incompatible with the jsonpath range syntax. So we get all pods
  // and filter.
  const [output] = await execCmd(
    `kubectl get pods -n ${namespace} --ignore-not-found -o jsonpath='{range .items[*]}{.metadata.name}:{.status.phase}{"\\n"}{end}'`,
  );
  // Filter out pods that are not in the list of resource names or are not running
  const running = output
    .split('\n')
    .map((line) => {
      const [pod, status] = line.split(':');
      return resourceNames.includes(pod) && status === 'Running'
        ? pod
        : undefined;
    })
    // TS isn't smart enough to know that the filter removes undefineds
    .filter((pod) => pod !== undefined) as string[];
  const missing = resourceNames.filter(
    (resource) => !running.includes(resource),
  );
  return { existing: running, missing };
}
