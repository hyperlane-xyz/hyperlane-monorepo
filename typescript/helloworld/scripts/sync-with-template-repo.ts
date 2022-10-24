/**
 * This script copies over files from this monorepo to the template repo
 * It assumes the template repo is available locally at PATH_TO_TEMPLATE_REPO
 * It will aggregate commits to this folder as the commit message
 * Pull requests must still be created and merged on the template repo
 *
 * Usage: yarn sync
 * Flags: --no-commit to skip automatic git committing and pushing
 *
 * Possible improvements:
 * 1. Clone template automatically if it doesn't exist
 * 2. Auto generate commit message based on changes since last sync
 * 3. Run in CI using github token
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';

const SKIP_GIT_FLAG = '--no-commit';

const PATH_TO_TEMPLATE_REPO = '../../../hyperlane-app-template';

const SYNC_WHITELIST = [
  'contracts',
  'src',
  '.gitignore',
  '.prettierignore',
  '.solcover.js',
  '.solhint.json',
  'hardhat.config.ts',
  'package.json',
  'README.md',
];

async function main() {
  console.info('Attempting to sync files with template repo');
  console.info('Using repo path:', PATH_TO_TEMPLATE_REPO);

  const args = process.argv.slice(2);
  const skipGit = args.includes(SKIP_GIT_FLAG);
  if (skipGit) {
    console.info('Skip git flag set, will not run any git commands');
  } else {
    console.info(
      'Skip git flag not set, will automatically commit and push changes to new branch',
    );
  }

  if (!existsSync(PATH_TO_TEMPLATE_REPO)) {
    throw new Error('No folder found at repo path');
  }

  const t = new Date();
  const date = `${t.getFullYear()}-${
    t.getMonth() + 1
  }-${t.getDate()}-${t.getHours()}-${t.getMinutes()}`;
  const branchName = `sync-${date}`;

  if (!skipGit) {
    execSync(`git checkout main && git pull`, { cwd: PATH_TO_TEMPLATE_REPO });
    execSync(`git checkout -b ${branchName}`, {
      cwd: PATH_TO_TEMPLATE_REPO,
    });
  }

  for (const f of SYNC_WHITELIST) {
    console.info(`Copying ${f}`);
    execSync(`cp -r ${f} ${PATH_TO_TEMPLATE_REPO}`);
  }

  console.info(`Running yarn to ensure up to date lockfile`);
  execSync(`yarn install`, { cwd: PATH_TO_TEMPLATE_REPO });

  if (!skipGit) {
    console.info(`Committing changes`);
    execSync(`git add . && git commit -m "Sync with monorepo"`, {
      cwd: PATH_TO_TEMPLATE_REPO,
    });
    execSync(`git push -u origin ${branchName}`, {
      cwd: PATH_TO_TEMPLATE_REPO,
    });
    console.info(
      `Changes pushed to branch ${branchName}, please create pull request manually`,
    );
  } else {
    console.info(`Please commit changes and create pull request manually`);
  }
}

main()
  .then(() => console.info('Sync complete!'))
  .catch((e) => console.error('Sync failed', e));
