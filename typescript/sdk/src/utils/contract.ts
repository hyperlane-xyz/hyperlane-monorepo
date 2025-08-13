import { compareVersions } from 'compare-versions';

export function isValidContractVersion(
  targetVersion: string,
  currentVersion: string,
): boolean {
  return compareVersions(targetVersion, currentVersion) >= 0;
}
