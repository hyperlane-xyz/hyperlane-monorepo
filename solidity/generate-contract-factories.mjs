import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';

const CONFIG = {
  artifactsRoots: (
    process.env.HYPERLANE_FACTORY_ARTIFACTS_ROOTS ??
    'artifacts,artifacts-zk'
  )
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => join(process.cwd(), path)),
  outputRoot: join(process.cwd(), 'core-utils/generated'),
  contractsOutputRoot: join(process.cwd(), 'core-utils/generated/contracts'),
  indexOutputPath: join(process.cwd(), 'core-utils/generated/index.ts'),
};

function isExportableIdentifier(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

async function collectArtifactPaths(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const paths = [];

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'build-info') continue;
      paths.push(...(await collectArtifactPaths(fullPath)));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    if (entry.name.endsWith('.dbg.json')) continue;
    paths.push(fullPath);
  }

  return paths;
}

async function pathExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function selectArtifact(existing, candidate) {
  if (!existing) return candidate;
  const existingHasBytecode =
    existing.bytecode &&
    existing.bytecode !== '0x' &&
    existing.bytecode.length > 2;
  const candidateHasBytecode =
    candidate.bytecode &&
    candidate.bytecode !== '0x' &&
    candidate.bytecode.length > 2;
  if (!existingHasBytecode && candidateHasBytecode) return candidate;
  return existing;
}

function uniqueStrings(values) {
  return [...new Set(values)].filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
}

function abiParamSignature(param) {
  if (!param?.type || typeof param.type !== 'string') return '';
  if (!param.type.startsWith('tuple')) return param.type;

  const tupleSuffix = param.type.slice('tuple'.length);
  const components = Array.isArray(param.components) ? param.components : [];
  const tupleFields = components.map((component) =>
    abiParamSignature(component),
  );
  return `(${tupleFields.join(',')})${tupleSuffix}`;
}

function functionSignature(item) {
  const inputs = Array.isArray(item?.inputs) ? item.inputs : [];
  return `${item.name}(${inputs.map((input) => abiParamSignature(input)).join(',')})`;
}

function renderMethodNamesUnion(methodNames) {
  if (!methodNames.length) return 'never';
  return methodNames.map((methodName) => JSON.stringify(methodName)).join(' | ');
}

function renderSignatureAliasType(sourceType, signatureAliases) {
  if (!signatureAliases.length) return '{}';
  const lines = signatureAliases
    .map(
      ({ signature, name }) =>
        `  ${JSON.stringify(signature)}: ${sourceType}[${JSON.stringify(name)}];`,
    )
    .join('\n');
  return `{\n${lines}\n}`;
}

function renderContractModuleSource(name, artifact) {
  const abiIdentifier = `${name}Abi`;
  const artifactIdentifier = `${name}Artifact`;

  return `/* eslint-disable */
/* THIS FILE IS AUTO-GENERATED. DO NOT EDIT DIRECTLY. */
import type { Abi } from 'viem';
import type { ArtifactEntry, RunnerLike, ViemContractLike } from '../../viemFactory.js';
import { ViemContractFactory } from '../../viemFactory.js';

export const ${abiIdentifier} = ${JSON.stringify(artifact.abi, null, 2)} as const satisfies Abi;

export const ${artifactIdentifier}: ArtifactEntry<typeof ${abiIdentifier}> = {
  contractName: ${JSON.stringify(artifact.contractName)},
  abi: ${abiIdentifier},
  bytecode: ${JSON.stringify(artifact.bytecode ?? '0x')},
};

type ${name}Methods = {
  [TName in ${renderMethodNamesUnion(artifact.functionNames)}]:
    ViemContractLike<typeof ${abiIdentifier}>['functions'][TName];
};

type ${name}EstimateGasMethods = {
  [TName in ${renderMethodNamesUnion(artifact.functionNames)}]:
    ViemContractLike<typeof ${abiIdentifier}>['estimateGas'][TName];
};

type ${name}SignatureMethods = ${renderSignatureAliasType(
    `ViemContractLike<typeof ${abiIdentifier}>['functions']`,
    artifact.functionAliases,
  )};

type ${name}EstimateGasSignatureMethods = ${renderSignatureAliasType(
    `ViemContractLike<typeof ${abiIdentifier}>['estimateGas']`,
    artifact.functionAliases,
  )};

export type ${name} = ViemContractLike<typeof ${abiIdentifier}> &
  Record<string, unknown> &
  ${name}Methods &
  ${name}SignatureMethods & {
  estimateGas: ViemContractLike<typeof ${abiIdentifier}>['estimateGas'] &
    ${name}EstimateGasMethods &
    ${name}EstimateGasSignatureMethods;
};

export class ${name}__factory extends ViemContractFactory<typeof ${abiIdentifier}, ${name}> {
  static readonly artifact = ${artifactIdentifier};

  static connect(address: string, runner?: RunnerLike): ${name} {
    return super.connect(address, runner) as ${name};
  }
}
`;
}

function renderGeneratedIndexSource(artifacts) {
  const names = [...artifacts.keys()].sort((a, b) => a.localeCompare(b));
  const exportLines = names
    .map((name) => `export * from './contracts/${name}.js';`)
    .join('\n');
  const importLines = names
    .map((name) => `import { ${name}Artifact } from './contracts/${name}.js';`)
    .join('\n');
  const mapEntries = names
    .map((name) => `  ${JSON.stringify(name)}: ${name}Artifact,`)
    .join('\n');

  return `/* eslint-disable */
/* THIS FILE IS AUTO-GENERATED. DO NOT EDIT DIRECTLY. */
import type { Abi } from 'viem';
import type { ArtifactEntry } from '../viemFactory.js';
${importLines}
${exportLines}

export const contractArtifacts: Record<string, ArtifactEntry<Abi>> = {
${mapEntries}
};

export function getContractArtifactByName(
  name: string,
): ArtifactEntry<Abi> | undefined {
  return contractArtifacts[name];
}
`;
}

async function generate() {
  const artifactPaths = [];
  for (const artifactsRoot of CONFIG.artifactsRoots) {
    if (!(await pathExists(artifactsRoot))) continue;
    artifactPaths.push(...(await collectArtifactPaths(artifactsRoot)));
  }
  if (!artifactPaths.length) {
    throw new Error(
      `No artifact files found under: ${CONFIG.artifactsRoots.join(', ')}`,
    );
  }
  const artifactsByName = new Map();

  for (const artifactPath of artifactPaths) {
    const content = await fs.readFile(artifactPath, 'utf8');
    const parsed = JSON.parse(content);
    const contractName = parsed.contractName ?? basename(artifactPath, '.json');
    if (!isExportableIdentifier(contractName)) continue;

    const artifactEntry = {
      contractName,
      abi: parsed.abi ?? [],
      bytecode: parsed.bytecode ?? '0x',
      functionSignatures: (() => {
        const functions = (parsed.abi ?? []).filter(
          (item) => item?.type === 'function' && typeof item?.name === 'string',
        );
        return uniqueStrings(functions.map((item) => functionSignature(item)));
      })(),
      functionNames: (() => {
        const functions = (parsed.abi ?? []).filter(
          (item) => item?.type === 'function' && typeof item?.name === 'string',
        );
        return uniqueStrings(functions.map((item) => item.name));
      })(),
      functionAliases: (() => {
        const functions = (parsed.abi ?? []).filter(
          (item) => item?.type === 'function' && typeof item?.name === 'string',
        );
        return [
          ...new Map(
            functions.map((item) => [
              functionSignature(item),
              {
                signature: functionSignature(item),
                name: item.name,
              },
            ]),
          ).values(),
        ];
      })(),
    };
    artifactsByName.set(
      contractName,
      selectArtifact(artifactsByName.get(contractName), artifactEntry),
    );
  }

  await fs.rm(CONFIG.outputRoot, { recursive: true, force: true });
  await fs.mkdir(CONFIG.contractsOutputRoot, { recursive: true });

  const names = [...artifactsByName.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const artifact = artifactsByName.get(name);
    const source = renderContractModuleSource(name, artifact);
    const modulePath = join(CONFIG.contractsOutputRoot, `${name}.ts`);
    await fs.writeFile(modulePath, source);
  }

  const indexSource = renderGeneratedIndexSource(artifactsByName);
  await fs.mkdir(dirname(CONFIG.indexOutputPath), { recursive: true });
  await fs.writeFile(CONFIG.indexOutputPath, indexSource);
  console.log(
    `Generated ${
      artifactsByName.size
    } viem contract factory modules under ${CONFIG.outputRoot}`,
  );
}

generate().catch((error) => {
  console.error('Failed to generate viem contract factories:', error);
  process.exit(1);
});
