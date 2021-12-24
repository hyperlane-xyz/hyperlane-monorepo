import { expect } from 'chai';
import { CallforwarderDeploy as Deploy } from './CallforwarderDeploy';

const emptyAddr = '0x' + '00'.repeat(32);

export async function checkCallforwarderDeploy(
  deploy: Deploy,
  remotes: number[],
) {
  const callforwarderRouter = deploy.contracts.callforwarderRouter!;
  await Promise.all(
    remotes.map(async (remoteDomain) => {
      const registeredRouter = await callforwarderRouter!.remotes(remoteDomain);
      expect(registeredRouter).to.not.equal(emptyAddr);
    }),
  );
}
