import { devCommunity } from 'optics-multi-provider-community';
import { ethers } from 'ethers';
import { configPath, networks } from './agentConfig';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
const deploys = makeCoreDeploys(
  configPath,
  networks,
  (_) => _.chain,
  (_) => _.devConfig,
);

function domainHash(domain: Number): string {
  return ethers.utils.solidityKeccak256(
    ['uint32', 'string'],
    [domain, 'OPTICS'],
  );
}

class Updater {
  localDomain: number;
  signer: ethers.Signer;
  address: string;
  constructor(signer: ethers.Signer, address: string, localDomain: number) {
    this.localDomain = localDomain ? localDomain : 0;
    this.signer = signer;
    this.address = address;
  }

  domainHash() {
    return domainHash(this.localDomain);
  }

  message(oldRoot: string, newRoot: string) {
    return ethers.utils.concat([this.domainHash(), oldRoot, newRoot]);
  }
  async signUpdate(oldRoot: string, newRoot: string) {
    let message = this.message(oldRoot, newRoot);
    let msgHash = ethers.utils.arrayify(ethers.utils.keccak256(message));
    let signature = await this.signer.signMessage(msgHash);
    return {
      origin: this.localDomain,
      oldRoot,
      newRoot,
      signature,
    };
  }
}

async function main() {
  devCommunity.registerRpcProvider('alfajores', process.env.ALFAJORES_RPC!);
  devCommunity.registerRpcProvider('gorli', process.env.GORLI_RPC!);
  devCommunity.registerRpcProvider('kovan', process.env.KOVAN_RPC!);
  devCommunity.registerRpcProvider('mumbai', process.env.MUMBAI_RPC!);
  devCommunity.registerRpcProvider('fuji', process.env.FUJI_RPC!);
  devCommunity.registerSigner(
    'alfajores',
    new ethers.Wallet(process.env.ALFAJORES_DEPLOYER_KEY!),
  );

  const fujiDeploy = deploys.find((_) => _.chain.name === 'fuji')!;
  const kovanDeploy = deploys.find((_) => _.chain.name === 'kovan')!;

  const kovanHome = kovanDeploy.contracts.home!;
  const kovanReplica =
    fujiDeploy.contracts.replicas[kovanDeploy?.chain.domain!]!;

  const homeRoot = await kovanHome.proxy.committedRoot();
  const replicaRoot = await kovanReplica.proxy.committedRoot();

  console.log(`homeRoot: ${homeRoot}, replicaRoot: ${replicaRoot}`);

  const updaterSigner = new ethers.Wallet('0x0');
  const updater = new Updater(
    // @ts-ignore
    updaterSigner,
    updaterSigner.address,
    kovanDeploy.chain.domain,
  );

  const fakeRoot = ethers.utils.formatBytes32String('fake root');
  const improperUpdate = await updater.signUpdate(homeRoot, fakeRoot);

  console.log(improperUpdate);
  const gas = await kovanReplica.proxy.estimateGas.update(
    homeRoot,
    fakeRoot,
    improperUpdate.signature,
  );
  const ret = await kovanReplica.proxy.callStatic.update(
    homeRoot,
    fakeRoot,
    improperUpdate.signature,
  );

  console.log(gas, ret);
}
main().then(console.log).catch(console.error);
