import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { assert } from '@hyperlane-xyz/utils';

import {
  SubmissionStrategy,
  SubmissionStrategySchema,
} from './builder/types.js';
import {
  SubmitterMetadata,
  SubmitterMetadataSchema,
  UnresolvedSubmitterReference,
  UnresolvedSubmitterReferenceSchema,
} from './types.js';

export interface SubmitterReferenceRegistry {
  getSubmitter?(
    ref: string,
  ): Promise<unknown | null | undefined> | unknown | null | undefined;
  getUri?(itemPath?: string): string;
  uri?: string;
  registries?: Array<Partial<SubmitterReferenceRegistry>>;
}

const SUBMITTER_DIRECTORY = 'submitters';
const SUPPORTED_EXTENSIONS = ['', '.yaml', '.yml', '.json'];

export const UnresolvedSubmissionStrategySchema = z
  .object({
    submitter: z.union([
      SubmitterMetadataSchema,
      UnresolvedSubmitterReferenceSchema,
    ]),
  })
  .strict();

export type UnresolvedSubmissionStrategy = z.infer<
  typeof UnresolvedSubmissionStrategySchema
>;

function isUnresolvedSubmitterReference(
  value: SubmitterMetadata | UnresolvedSubmitterReference,
): value is UnresolvedSubmitterReference {
  return value.type === 'submitter_ref';
}

function parseResolvedSubmitterPayload(
  payload: unknown,
  ref: string,
): SubmitterMetadata {
  const strategyResult = SubmissionStrategySchema.safeParse(payload);
  if (strategyResult.success) {
    return strategyResult.data.submitter;
  }

  const metadataResult = SubmitterMetadataSchema.safeParse(payload);
  if (metadataResult.success) {
    return metadataResult.data;
  }

  throw new Error(
    `Submitter reference ${ref} did not resolve to SubmitterMetadata or SubmissionStrategy`,
  );
}

export async function resolveSubmitterMetadata(
  submitter:
    | SubmitterMetadata
    | UnresolvedSubmitterReference
    | Promise<SubmitterMetadata | UnresolvedSubmitterReference>,
  registry?: Partial<SubmitterReferenceRegistry>,
): Promise<SubmitterMetadata> {
  const awaitedSubmitter = await submitter;
  if (!isUnresolvedSubmitterReference(awaitedSubmitter)) {
    return awaitedSubmitter;
  }

  assert(
    registry,
    `Submitter reference ${awaitedSubmitter.ref} requires a registry`,
  );

  const payload =
    (registry.getSubmitter
      ? await registry.getSubmitter(awaitedSubmitter.ref)
      : null) ??
    (await loadSubmitterReferenceFromRegistry(registry, awaitedSubmitter.ref));
  assert(payload, `Submitter reference ${awaitedSubmitter.ref} was not found`);
  return parseResolvedSubmitterPayload(payload, awaitedSubmitter.ref);
}

export async function resolveSubmissionStrategy(
  strategy:
    | UnresolvedSubmissionStrategy
    | SubmissionStrategy
    | Promise<UnresolvedSubmissionStrategy | SubmissionStrategy>,
  registry?: Partial<SubmitterReferenceRegistry>,
): Promise<SubmissionStrategy> {
  const awaitedStrategy = await strategy;
  return {
    ...awaitedStrategy,
    submitter: await resolveSubmitterMetadata(
      awaitedStrategy.submitter,
      registry,
    ),
  };
}

export function parseSubmitterReferencePayload(
  payload: string,
  source: string,
): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    try {
      return parseYaml(payload);
    } catch (error) {
      throw new Error(
        `Failed to parse submitter reference payload from ${source}: ${String(error)}`,
      );
    }
  }
}

async function loadSubmitterReferenceFromRegistry(
  registry: Partial<SubmitterReferenceRegistry>,
  ref: string,
): Promise<unknown | null> {
  if (registry.registries?.length) {
    for (const childRegistry of registry.registries) {
      const payload = await loadSubmitterReferenceFromRegistry(
        childRegistry,
        ref,
      );
      if (payload) {
        return payload;
      }
    }

    return null;
  }

  assert(
    registry.getUri || registry.uri,
    `Submitter reference ${ref} requires a registry with getSubmitter(ref), getUri(itemPath), or uri support`,
  );

  for (const itemPath of getCandidateItemPaths(ref, registry)) {
    for (const source of getCandidateSources(itemPath, registry)) {
      const payload = await loadReferencePayload(source);
      if (payload) {
        return parseSubmitterReferencePayload(payload, source);
      }
    }
  }

  return null;
}

function getCandidateItemPaths(
  ref: string,
  registry: Partial<SubmitterReferenceRegistry>,
): string[] {
  const relativeRef = stripRegistryRoot(ref, registry) ?? ref;
  const normalizedRef = relativeRef.replace(/^\/+/, '');
  assert(
    normalizedRef.startsWith(`${SUBMITTER_DIRECTORY}/`),
    `Submitter reference ${ref} must target a top-level ${SUBMITTER_DIRECTORY}/ entry`,
  );

  if (hasSupportedExtension(normalizedRef)) {
    return [normalizedRef];
  }

  return SUPPORTED_EXTENSIONS.map((suffix) => `${normalizedRef}${suffix}`);
}

function stripRegistryRoot(
  ref: string,
  registry: Partial<SubmitterReferenceRegistry>,
): string | null {
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

function getCandidateSources(
  itemPath: string,
  registry: Partial<SubmitterReferenceRegistry>,
): string[] {
  const sources = [safeGetUri(registry, itemPath)];

  if (registry.uri && registry.uri !== '__merged_registry__') {
    sources.push(`${registry.uri.replace(/\/+$/, '')}/${itemPath}`);
  }

  return sources.filter(
    (source, index, values): source is string =>
      !!source && values.indexOf(source) === index,
  );
}

function safeGetUri(
  registry: Partial<SubmitterReferenceRegistry>,
  itemPath?: string,
): string | undefined {
  try {
    return registry.getUri?.(itemPath);
  } catch {
    return undefined;
  }
}

async function loadReferencePayload(source: string): Promise<string | null> {
  try {
    if (!isHttpUrl(source)) {
      return null;
    }

    const response = await fetch(source);
    if (!response.ok) {
      return null;
    }
    return response.text();
  } catch {
    return null;
  }
}

function hasSupportedExtension(value: string): boolean {
  return SUPPORTED_EXTENSIONS.some((extension) => {
    return extension.length > 0 && value.endsWith(extension);
  });
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}
