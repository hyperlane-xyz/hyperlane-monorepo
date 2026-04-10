import { type IRegistry, WarpRouteFilterParams } from '@hyperlane-xyz/registry';
import {
  type SubmissionStrategy,
  SubmissionStrategySchema,
  TxSubmitterType,
  parseSubmitterReferencePayload,
  resolveSubmitterMetadata,
} from '@hyperlane-xyz/sdk';
import { readYamlOrJson } from '@hyperlane-xyz/utils/fs';

import { AbstractService } from './abstractService.js';
import { RegistryService } from './registryService.js';

export class RootService extends AbstractService {
  constructor(registryService: RegistryService) {
    super(registryService);
  }

  async getMetadata() {
    return this.withRegistry(async (registry) => {
      return registry.getMetadata();
    });
  }

  async getAddresses() {
    return this.withRegistry(async (registry) => {
      return registry.getAddresses();
    });
  }

  async getChains() {
    return this.withRegistry(async (registry) => {
      return registry.getChains();
    });
  }

  async listRegistryContent() {
    return this.withRegistry(async (registry) => {
      return registry.listRegistryContent();
    });
  }

  async getWarpRoutes(filter?: WarpRouteFilterParams) {
    return this.withRegistry(async (registry) => {
      return registry.getWarpRoutes(filter);
    });
  }

  async getSubmitter(id: string): Promise<SubmissionStrategy> {
    return this.withRegistry(async (registry) => {
      const submitter = await resolveSubmitterMetadata(
        { type: TxSubmitterType.SUBMITTER_REF, ref: `submitters/${id}` },
        extendRegistryWithSubmitters(registry),
      );
      return SubmissionStrategySchema.parse({ submitter });
    });
  }
}

const SUBMITTER_DIRECTORY = 'submitters';
const SUPPORTED_EXTENSIONS = ['', '.yaml', '.yml', '.json'];

export type SubmitterRegistry = IRegistry & {
  getSubmitter(ref: string): Promise<unknown>;
};

export function extendRegistryWithSubmitters(
  registry: IRegistry,
): SubmitterRegistry {
  const extendedRegistry = registry as SubmitterRegistry;
  if (!Object.hasOwn(extendedRegistry, 'getSubmitter')) {
    extendedRegistry.getSubmitter = async (ref) =>
      readSubmitterReference(registry, ref);
  }
  return extendedRegistry;
}

async function readSubmitterReference(
  registry: IRegistry,
  ref: string,
): Promise<unknown> {
  const childRegistries = getRegistryChildren(registry);
  if (childRegistries?.length) {
    for (const childRegistry of childRegistries.slice().reverse()) {
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

function getRegistryChildren(registry: IRegistry): IRegistry[] {
  if (!('registries' in registry) || !Array.isArray(registry.registries)) {
    return [];
  }

  return registry.registries.filter(
    (child): child is IRegistry => !!child && typeof child === 'object',
  );
}

function getCandidateItemPaths(ref: string, registry: IRegistry): string[] {
  const strippedRef = stripRegistryRoot(ref, registry);
  if (!strippedRef && isUrl(ref)) return [];

  const normalizedRef = (strippedRef ?? ref).replace(/^\/+/, '');
  if (!normalizedRef.startsWith(`${SUBMITTER_DIRECTORY}/`)) {
    throw new Error(
      `Submitter reference ${ref} must target a top-level ${SUBMITTER_DIRECTORY}/ entry`,
    );
  }

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
    if (!response.ok) {
      throw new Error(
        `Failed to fetch submitter reference ${source}: ${response.status} ${response.statusText}`,
      );
    }
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
