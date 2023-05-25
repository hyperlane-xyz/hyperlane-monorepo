import { after } from 'mocha';

import { HelmCommand, buildHelmChartDependencies } from '../utils/helm';
import { execCmd } from '../utils/utils';

export abstract class Helmable {
  abstract readonly helmReleaseName: string;
  abstract readonly namespace: string;
  abstract readonly helmChartPath: string;

  abstract async helmValues(): Promise<string[]>;

  async before(action: HelmCommand): Promise<void> {
    return;
  }

  async after(action: HelmCommand): Promise<void> {
    return;
  }

  async run(action: HelmCommand): Promise<void> {
    await before(action);

    const args = ['helm', action, this.helmReleaseName];

    if (
      action == HelmCommand.InstallOrUpgrade ||
      action == HelmCommand.UpgradeDiff
    )
      args.push(this.helmChartPath);

    args.push('--namespace', this.namespace);

    if (action == HelmCommand.InstallOrUpgrade) args.push('--create-namespace');

    if (action == HelmCommand.UpgradeDiff)
      cmd.push(
        `| kubectl diff --namespace ${this.namespace} --field-manager="Go-http-client" -f - || true`,
      );

    if (action == HelmCommand.InstallOrUpgrade || HelmCommand.UpgradeDiff)
      args.push(...(await this.helmValues()));

    await buildHelmChartDependencies(this.helmChartPath);
    await execCmd(args.join(' '), {}, false, true);
    await after(action);
  }
}
