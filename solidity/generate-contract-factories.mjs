import {promises as fs} from "fs";
import {basename, dirname, join} from "path";

const CONFIG = {
    artifactsRoot: join(process.cwd(), "artifacts"),
    outputRoot: join(process.cwd(), "core-utils/generated"),
    contractsOutputRoot: join(process.cwd(), "core-utils/generated/contracts"),
    indexOutputPath: join(process.cwd(), "core-utils/generated/index.ts"),
};

function isExportableIdentifier(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

async function collectArtifactPaths(dirPath) {
    const entries = await fs.readdir(dirPath, {withFileTypes: true});
    const paths = [];

    for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "build-info") continue;
            paths.push(...(await collectArtifactPaths(fullPath)));
            continue;
        }

        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".json")) continue;
        if (entry.name.endsWith(".dbg.json")) continue;
        paths.push(fullPath);
    }

    return paths;
}

function selectArtifact(existing, candidate) {
    if (!existing) return candidate;
    const existingHasBytecode =
        existing.bytecode &&
        existing.bytecode !== "0x" &&
        existing.bytecode.length > 2;
    const candidateHasBytecode =
        candidate.bytecode &&
        candidate.bytecode !== "0x" &&
        candidate.bytecode.length > 2;
    if (!existingHasBytecode && candidateHasBytecode) return candidate;
    return existing;
}

function uniqueIdentifiers(values) {
    return [...new Set(values)].filter((name) =>
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name),
    );
}

function renderMethodType(methodNames, returnType) {
    if (!methodNames.length) return "{}";
    const lines = methodNames
        .map(
            (methodName) =>
                `    ${JSON.stringify(methodName)}: (...args: any[]) => ${returnType};`,
        )
        .join("\n");
    return `{\n${lines}\n  }`;
}

function renderContractModuleSource(name, artifact) {
    const functionNames = artifact.functionNames;
    const eventNames = artifact.eventNames;
    const artifactIdentifier = `${name}Artifact`;

    return `/* eslint-disable */
/* THIS FILE IS AUTO-GENERATED. DO NOT EDIT DIRECTLY. */
import type { ArtifactEntry, ViemContractLike } from '../../viemFactory.js';
import { ViemContractFactory } from '../../viemFactory.js';

export const ${artifactIdentifier}: ArtifactEntry = ${JSON.stringify(
        {
            contractName: artifact.contractName,
            abi: artifact.abi,
            bytecode: artifact.bytecode ?? "0x",
        },
        null,
        2,
    )};

export type ${name} = ViemContractLike & {
  ${renderMethodType(functionNames, "Promise<any>").slice(2, -2)}
  populateTransaction: ${renderMethodType(functionNames, "Promise<any>")};
  callStatic: ${renderMethodType(functionNames, "Promise<any>")};
  estimateGas: ${renderMethodType(functionNames, "Promise<bigint>")};
  filters: ${renderMethodType(eventNames, "Record<string, unknown>")};
};
export class ${name}__factory extends ViemContractFactory {
  static readonly artifact = ${artifactIdentifier};
  static connect(address: string, runner?: any): ${name} {
    return super.connect(address, runner) as ${name};
  }
  override attach(address: string): ${name} {
    return super.attach(address) as ${name};
  }
  override async deploy(...rawArgs: readonly unknown[]): Promise<${name}> {
    return super.deploy(...rawArgs) as Promise<${name}>;
  }
}
`;
}

function renderGeneratedIndexSource(artifacts) {
    const names = [...artifacts.keys()].sort((a, b) => a.localeCompare(b));
    const exportLines = names
        .map((name) => `export * from './contracts/${name}.js';`)
        .join("\n");
    const importLines = names
        .map(
            (name) =>
                `import { ${name}Artifact } from './contracts/${name}.js';`,
        )
        .join("\n");
    const mapEntries = names
        .map((name) => `  ${JSON.stringify(name)}: ${name}Artifact,`)
        .join("\n");

    return `/* eslint-disable */
/* THIS FILE IS AUTO-GENERATED. DO NOT EDIT DIRECTLY. */
import type { ArtifactEntry } from '../viemFactory.js';
${importLines}
${exportLines}

export const contractArtifacts: Record<string, ArtifactEntry> = {
${mapEntries}
};

export function getContractArtifactByName(
  name: string,
): ArtifactEntry | undefined {
  return contractArtifacts[name];
}
`;
}

async function generate() {
    const artifactPaths = await collectArtifactPaths(CONFIG.artifactsRoot);
    const artifactsByName = new Map();

    for (const artifactPath of artifactPaths) {
        const content = await fs.readFile(artifactPath, "utf8");
        const parsed = JSON.parse(content);
        const contractName =
            parsed.contractName ?? basename(artifactPath, ".json");
        if (!isExportableIdentifier(contractName)) continue;

        const artifactEntry = {
            contractName,
            abi: parsed.abi ?? [],
            bytecode: parsed.bytecode ?? "0x",
            functionNames: uniqueIdentifiers(
                (parsed.abi ?? [])
                    .filter((item) => item?.type === "function")
                    .map((item) => item.name),
            ),
            eventNames: uniqueIdentifiers(
                (parsed.abi ?? [])
                    .filter((item) => item?.type === "event")
                    .map((item) => item.name),
            ),
        };
        artifactsByName.set(
            contractName,
            selectArtifact(artifactsByName.get(contractName), artifactEntry),
        );
    }

    await fs.rm(CONFIG.outputRoot, {recursive: true, force: true});
    await fs.mkdir(CONFIG.contractsOutputRoot, {recursive: true});

    const names = [...artifactsByName.keys()].sort((a, b) =>
        a.localeCompare(b),
    );
    for (const name of names) {
        const artifact = artifactsByName.get(name);
        const source = renderContractModuleSource(name, artifact);
        const modulePath = join(CONFIG.contractsOutputRoot, `${name}.ts`);
        await fs.writeFile(modulePath, source);
    }

    const indexSource = renderGeneratedIndexSource(artifactsByName);
    await fs.mkdir(dirname(CONFIG.indexOutputPath), {recursive: true});
    await fs.writeFile(CONFIG.indexOutputPath, indexSource);
    console.log(
        `Generated ${
            artifactsByName.size
        } viem contract factory modules under ${CONFIG.outputRoot}`,
    );
}

generate().catch((error) => {
    console.error("Failed to generate viem contract factories:", error);
    process.exit(1);
});
