import { register } from 'tsx/esm/api';
import { workerData } from 'node:worker_threads';

register();
const { StarknetArtifactGenerator } =
  await import('./StarknetArtifactGenerator.ts');
const generator = new StarknetArtifactGenerator(
  workerData.compiledContractsDir,
  workerData.rootOutputDir,
);
for (const file of workerData.files) {
  await generator.processArtifact(file);
}
