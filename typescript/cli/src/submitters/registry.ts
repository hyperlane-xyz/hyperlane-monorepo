import { type IRegistry } from '@hyperlane-xyz/registry';
import {
  type SubmitterReferenceRegistry,
  parseSubmitterReferencePayload,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../utils/files.js';

const SUBMITTER_DIRECTORY = 'submitters';
const SUPPORTED_EXTENSIONS = ['', '.yaml', '.yml', '.json'];

export function createSubmitterReferenceRegistry(
  registry: IRegistry,
): SubmitterReferenceRegistry {
  return {
    uri: registry.uri,
    getUri: (itemPath) => safeGetUri(registry, itemPath) ?? registry.uri,
    getSubmitter: async (ref) => readSubmitterReference(registry, ref),
  };
}

async function readSubmitterReference(
  registry: IRegistry,
  ref: string,
): Promise<unknown> {
  const childRegistries = (registry as IRegistry & { registries?: IRegistry[] })
    .registries;
  if (childRegistries?.length) {
    for (const childRegistry of childRegistries) {
      const payload = await readSubmitterReference(childRegistry, ref);
      if (payload) return payload;
    }
  }

  for (const itemPath of getCandidateItemPaths(ref, registry)) {
    const source = safeGetUri(registry, itemPath);
    if (!source) continue;

    const payload = await loadPayload(source);
    if (payload) return payload;
  }

  return null;
}

function getCandidateItemPaths(ref: string, registry: IRegistry): string[] {
  const normalizedRef = (stripRegistryRoot(ref, registry) ?? ref).replace(
    /^\/+/,
    '',
  );
  assert(
    normalizedRef.startsWith(`${SUBMITTER_DIRECTORY}/`),
    `Submitter reference ${ref} must target a top-level ${SUBMITTER_DIRECTORY}/ entry`,
  );

  if (
    SUPPORTED_EXTENSIONS.some(
      (extension) => extension && normalizedRef.endsWith(extension),
    )
  ) {
    return [normalizedRef];
  }

  return SUPPORTED_EXTENSIONS.map((suffix) => `${normalizedRef}${suffix}`);
}

function stripRegistryRoot(ref: string, registry: IRegistry): string | null {
  const roots = [registry.uri, safeGetUri(registry)]
    .filter(
      (value, index, values): value is string =>
        !!value && values.indexOf(value) === index,
    )
    .sort((a, b) => b.length - a.length);

  for (const root of roots) {
    if (ref.startsWith(root)) {
      return ref.slice(root.length).replace(/^\/+/, '');
    }
  }

  return null;
}

function safeGetUri(
  registry: IRegistry,
  itemPath?: string,
): string | undefined {
  try {
    return registry.getUri(itemPath);
  } catch {
    return undefined;
  }
}

async function loadPayload(source: string): Promise<unknown> {
  try {
    if (isFetchableUrl(source)) {
      const response = await fetch(source);
      if (!response.ok) return null;
      return parseSubmitterReferencePayload(await response.text(), source);
    }

    return readYamlOrJson(source);
  } catch {
    return null;
  }
}

function isFetchableUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
