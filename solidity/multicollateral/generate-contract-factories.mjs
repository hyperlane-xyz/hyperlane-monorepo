import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const GENERATED_ROOT = join(ROOT, 'generated');
const GENERATED_CONTRACTS_ROOT = join(GENERATED_ROOT, 'contracts');
const GENERATED_INDEX = join(GENERATED_ROOT, 'index.ts');

const ARTIFACTS = [
  {
    name: 'MultiCollateral',
    path: 'out/MultiCollateral.sol/MultiCollateral.json',
  },
  {
    name: 'MultiCollateralRoutingFee',
    path: 'out/MultiCollateralRoutingFee.sol/MultiCollateralRoutingFee.json',
  },
  {
    name: 'IMultiCollateralFee',
    path: 'out/IMultiCollateralFee.sol/IMultiCollateralFee.json',
  },
];

function renderContractSource(name, artifact) {
  const abiIdentifier = `${name}Abi`;
  const artifactIdentifier = `${name}Artifact`;

  return `/* eslint-disable */
/* THIS FILE IS AUTO-GENERATED. DO NOT EDIT DIRECTLY. */
import type { Abi } from 'viem';
import type {
  ArtifactEntry,
  ContractMethodMap,
  RunnerLike,
  ViemContractLike,
} from '@hyperlane-xyz/core';
import { ViemContractFactory } from '@hyperlane-xyz/core';

export const ${abiIdentifier} = ${JSON.stringify(
    artifact.abi,
    null,
    2,
  )} as const satisfies Abi;

export const ${artifactIdentifier}: ArtifactEntry<typeof ${abiIdentifier}> = {
  contractName: ${JSON.stringify(name)},
  abi: ${abiIdentifier},
  bytecode: ${JSON.stringify(artifact.bytecode)},
};

type ${name}Methods = ContractMethodMap<typeof ${abiIdentifier}>;

type ${name}EstimateGasMethods = {
  [TName in keyof ${name}Methods]: ViemContractLike<typeof ${abiIdentifier}>['estimateGas'][TName];
};

export type ${name} = ViemContractLike<typeof ${abiIdentifier}> &
  ${name}Methods & {
    estimateGas: ViemContractLike<typeof ${abiIdentifier}>['estimateGas'] &
      ${name}EstimateGasMethods;
  };

export class ${name}__factory extends ViemContractFactory<typeof ${abiIdentifier}, ${name}> {
  static readonly artifact = ${artifactIdentifier};

  static connect(address: string, runner?: RunnerLike): ${name} {
    return super.connect(address, runner) as ${name};
  }
}
`;
}

function renderIndexSource(contracts) {
  const names = contracts.map((artifact) => artifact.name);
  const imports = names
    .map(
      (name) =>
        `import { ${name}Artifact } from './contracts/${name}.js';`,
    )
    .join('\n');
  const exports = names
    .map((name) => `export * from './contracts/${name}.js';`)
    .join('\n');
  const entries = names
    .map((name) => `  ${JSON.stringify(name)}: ${name}Artifact,`)
    .join('\n');

  return `/* eslint-disable */
/* THIS FILE IS AUTO-GENERATED. DO NOT EDIT DIRECTLY. */
import type { Abi } from 'viem';
import type { ArtifactEntry } from '@hyperlane-xyz/core';
${imports}
${exports}

export const contractArtifacts: Record<string, ArtifactEntry<Abi>> = {
${entries}
};

export function getContractArtifactByName(
  name: string,
): ArtifactEntry<Abi> | undefined {
  return contractArtifacts[name];
}
`;
}

async function cleanGenerated() {
  await fs.rm(GENERATED_ROOT, { recursive: true, force: true });
  await fs.mkdir(GENERATED_CONTRACTS_ROOT, { recursive: true });
}

async function readArtifact(path) {
  const source = await fs.readFile(join(ROOT, path), 'utf8');
  const parsed = JSON.parse(source);
  const bytecode =
    typeof parsed.bytecode === 'string'
      ? parsed.bytecode
      : typeof parsed.bytecode?.object === 'string'
      ? parsed.bytecode.object
      : '0x';
  return {
    abi: Array.isArray(parsed.abi) ? parsed.abi : [],
    bytecode:
      typeof bytecode === 'string' && bytecode.length > 0 ? bytecode : '0x',
  };
}

async function generate() {
  await cleanGenerated();

  const contracts = [];
  for (const artifact of ARTIFACTS) {
    const content = await readArtifact(artifact.path);
    contracts.push({
      name: artifact.name,
      ...content,
    });
  }

  await Promise.all(
    contracts.map((artifact) =>
      fs.writeFile(
        join(GENERATED_CONTRACTS_ROOT, `${artifact.name}.ts`),
        renderContractSource(artifact.name, artifact),
      ),
    ),
  );
  await fs.writeFile(GENERATED_INDEX, renderIndexSource(contracts));
}

generate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
