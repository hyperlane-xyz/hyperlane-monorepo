import { execCmd } from "./utils";

export async function createNamespaceIfNotExists(namespace: string) {
  await execCmd(`kubectl get namespace ${namespace} >/dev/null 2>&1 || kubectl create namespace ${namespace}`);
}