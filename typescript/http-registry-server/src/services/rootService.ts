import { type IRegistry, WarpRouteFilterParams } from '@hyperlane-xyz/registry';
import {
  type SubmissionStrategy,
  SubmissionStrategySchema,
  type SubmitterReferenceRegistry,
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
        createSubmitterReferenceRegistry(registry),
      );
      return SubmissionStrategySchema.parse({ submitter });
    });
  }
}

const SUBMITTER_DIRECTORY = 'submitters';
const SUPPORTED_EXTENSIONS = ['', '.yaml', '.yml', '.json'];

function createSubmitterReferenceRegistry(
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
