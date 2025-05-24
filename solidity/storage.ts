import { validateUpgradeSafety } from '@openzeppelin/upgrades-core';
import { execSync } from 'child_process';

/**
 * Switches to a specific git commit
 * @param commitHash - The commit hash to switch to
 * @throws Error if git checkout fails
 */
export function switchToCommit(commitHash: string): void {
  try {
    // Checkout the specific commit
    execSync(`git checkout ${commitHash}`, { stdio: 'inherit' });

    console.log(`Successfully switched to commit: ${commitHash}`);
  } catch (error) {
    console.error(`Failed to switch to commit ${commitHash}:`, error);
    throw error;
  }
}

/**
 * Runs forge clean and build commands in sequence
 * @throws Error if either command fails
 */
export function runForgeCommands(isOld: boolean): void {
  try {
    console.log('Running forge clean...');
    execSync('forge clean', { stdio: 'inherit' });

    const dirName = isOld ? 'out-old' : 'out';
    const buildInfoDir = isOld ? 'build-info-old' : 'build-info';
    const buildInfoPath = `${dirName}/${buildInfoDir}`;
    console.log('Running forge build...');
    execSync(
      `forge build --build-info --build-info-path ${buildInfoPath} --out ${dirName} --extra-output storageLayout`,
      {
        stdio: 'inherit',
      },
    );

    console.log('Forge commands completed successfully');
  } catch (error) {
    console.error('Failed to run forge commands:', error);
    throw error;
  }
}

// Check contract layout
async function checkLayout(contractName: string): Promise<void> {
  const validationReport = validateUpgradeSafety(
    `out/build-info`,
    contractName,
    `build-info-old:${contractName}`,
    {},
    [`out-old/build-info-old`],
  );
}

// Main execution
async function main() {
  try {
    // Get two commits
    const commits = process.argv.slice(-2);

    switchToCommit(commits[0]);

    // Put output of forge into out-old
    runForgeCommands(true);

    switchToCommit(commits[1]);

    // Put output of of forge into out
    runForgeCommands(false);

    // Run openzeppelin command to actually output the code
    // Use flags --contract contractName --reference out-old:ContractName --referenceBuildInfoDirs out-old
    await checkLayout('HypERC20Collateral');
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
