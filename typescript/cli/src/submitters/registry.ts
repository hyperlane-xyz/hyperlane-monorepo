import { type IRegistry } from '@hyperlane-xyz/registry';
import {
  type SubmitterReferenceRegistry,
  getSubmitterRegistryChildren,
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
  const childRegistries = getSubmitterRegistryChildren(registry);
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
  if (isFetchableUrl(source)) {
    const response = await fetch(source);
    if (response.status === 404) return null;
    assert(
      response.ok,
      `Failed to fetch submitter reference ${source}: ${response.status} ${response.statusText}`,
    );
    return parseSubmitterReferencePayload(await response.text(), source);
  }
  if (isUrl(source)) return null;

  try {
    return readYamlOrJson(source);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function isFetchableUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
