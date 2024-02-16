import latestVersion from 'latest-version';

import { logRed } from '../../logger.js';
import { VERSION } from '../version.js';

export async function checkVersion() {
  const currentVersion = await latestVersion('@hyperlane-xyz/cli');
  if (VERSION < currentVersion) {
    logRed(`Please update your CLI to latest version(${currentVersion})`);
  }
}
