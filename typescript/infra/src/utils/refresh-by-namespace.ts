interface NamespacedManager {
  namespace: string;
}

interface RefreshOptions {
  skipConfirmation?: boolean;
}

type RefreshResourcesFn<TManager, TResourceType> = (
  managers: TManager[],
  resourceType: TResourceType,
  namespace: string,
  options?: RefreshOptions,
) => Promise<void>;

export async function refreshK8sResourcesByNamespace<
  TManager extends NamespacedManager,
  TResourceType,
>(
  managers: TManager[],
  resourceType: TResourceType,
  options: RefreshOptions | undefined,
  refreshResources: RefreshResourcesFn<TManager, TResourceType>,
): Promise<void> {
  const managersByNamespace = new Map<string, TManager[]>();
  for (const manager of managers) {
    const existing = managersByNamespace.get(manager.namespace) ?? [];
    existing.push(manager);
    managersByNamespace.set(manager.namespace, existing);
  }

  for (const [namespace, namespaceManagers] of managersByNamespace) {
    await refreshResources(namespaceManagers, resourceType, namespace, options);
  }
}
