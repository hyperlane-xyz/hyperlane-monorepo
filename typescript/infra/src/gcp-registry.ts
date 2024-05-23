// import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
// import { Logger } from 'pino';

// import {
//   BaseRegistry,
//   ChainAddresses,
//   IRegistry,
//   RegistryContent,
//   RegistryType,
// } from '@hyperlane-xyz/registry';
// import {
//   ChainMap,
//   ChainMetadata,
//   ChainName,
//   WarpCoreConfig,
// } from '@hyperlane-xyz/sdk';
// import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

// import { DeployEnvironment } from './config/environment.js';

// export class GcpSecretRpcUrlRegistry extends BaseRegistry implements IRegistry {
//   public readonly type = RegistryType.Local;

//   private readonly client: SecretManagerServiceClient;

//   constructor(private readonly env: DeployEnvironment, logger: Logger) {
//     super({ uri: 'foo', logger });
//     this.client = new SecretManagerServiceClient({
//       projectId: 'abacus-labs-dev',
//     });
//   }

//   async listRegistryContent(): Promise<RegistryContent> {
//     if (this.listContentCache) return this.listContentCache;

//     const content: RegistryContent = {
//       chains: {},
//       deployments: {},
//     };

//     // await this.client.initialize();
//     console.log(`name ~ "${this.env}-rpc-endpoints-.*"`);

//     await this.client.initialize();
//     console.log('this.client.auth', this.client.auth);

//     const projectId = await this.client.getProjectId();
//     console.log('projectId', projectId);

//     const secretsList = this.client.listSecretsAsync({
//       parent: `projects/${projectId}`,
//       // This matches substrings; unfortunately the API doesn't support regex
//       filter: `name:${this.env}-rpc-endpoints-`,
//     });

//     const chainNameRegex = new RegExp(`.*-(.*?)$`);
//     for await (const secret of secretsList) {
//       console.log('secret', secret);
//       // Should never happen, as we filter by name when listing
//       if (!secret.name) {
//         this.logger.warn('Secret missing name', secret);
//         continue;
//       }
//       const match = secret.name.match(chainNameRegex);
//       if (!match || match[1] === undefined) {
//         this.logger.warn('Secret name does not match expected format', secret);
//         continue;
//       }
//       const chainName = match[1];

//       content.chains[chainName] = {
//         metadata: this.getSecretVersionPath(projectId, secret.name),
//       };

//       //   const [secretVersion] = await this.client.accessSecretVersion({
//       //     name: `projects/${projectId}/secrets/${secret.name}/versions/latest`,
//       //   });
//       //   const secretData = secretVersion.payload?.data;
//       //   if (!secretData) {
//       //     this.logger.warn('Secret missing payload', secret);
//       //     continue;
//       //   }

//       //   // Handle both string and Uint8Array
//       //   let dataStr: string;
//       //   if (typeof secretData === 'string') {
//       //     dataStr = secretData;
//       //   } else {
//       //     dataStr = new TextDecoder().decode(secretData);
//       //   }

//       //   const rpcUrls = JSON.parse(dataStr);
//     }

//     // throw new Error("Method not implemented.");

//     return (this.listContentCache = content);
//   }

//   async getChains(): Promise<Array<ChainName>> {
//     const contents = await this.listRegistryContent();
//     return Object.keys(contents.chains);
//   }

//   async getMetadata(): Promise<ChainMap<ChainMetadata>> {
//     if (this.metadataCache) return this.metadataCache;

//     const registryContent = await this.listRegistryContent();

//     const chainMetadata: ChainMap<Partial<ChainMetadata>> = await promiseObjAll(
//       objMap(registryContent.chains, async (_, chainFiles) => {
//         if (!chainFiles.metadata) {
//           return {};
//         }
//         const data = await this.getSecretData(chainFiles.metadata);
//         const rpcUrls = JSON.parse(data);
//         return {
//           rpcUrls: rpcUrls.map((rpcUrl: string) => ({
//             http: rpcUrl,
//           })),
//         };
//       }),
//     );

//     return (this.metadataCache = chainMetadata as ChainMap<ChainMetadata>);
//   }

//   async getChainMetadata(chainName: ChainName): Promise<ChainMetadata | null> {
//     if (this.metadataCache?.[chainName]) return this.metadataCache[chainName];

//     throw new Error('Method not implemented.');
//   }

//   async getAddresses(): Promise<ChainMap<ChainAddresses>> {
//     return {};
//   }

//   async getChainAddresses(
//     chainName: ChainName,
//   ): Promise<ChainAddresses | null> {
//     return null;
//   }

//   async addChain(chain: {
//     chainName: ChainName;
//     metadata?: ChainMetadata;
//     addresses?: ChainAddresses;
//   }): Promise<void> {
//     // Do nothing
//   }

//   async updateChain(chain: {
//     chainName: ChainName;
//     metadata?: ChainMetadata;
//     addresses?: ChainAddresses;
//   }): Promise<void> {
//     // Do nothing
//   }

//   async removeChain(chain: ChainName): Promise<void> {
//     // Do nothing
//   }

//   async addWarpRoute(config: WarpCoreConfig): Promise<void> {
//     // Do nothing
//   }

//   async getSecretData(secretPath: string): Promise<string> {
//     const [secretVersion] = await this.client.accessSecretVersion({
//       name: secretPath,
//     });
//     const secretData = secretVersion.payload?.data;
//     if (!secretData) {
//       throw Error(`Secret ${secretPath} missing payload`);
//     }

//     // Handle both string and Uint8Array
//     if (typeof secretData === 'string') {
//       return secretData;
//     }
//     return new TextDecoder().decode(secretData);
//   }

//   getRpcUrlSecretVersionPath(projectId: string, chain: string): string {
//     return this.getSecretVersionPath(
//       projectId,
//       `${this.env}-rpc-endpoints-${chain}`,
//     );
//   }

//   getSecretVersionPath(projectId: string, secretName: string): string {
//     return `projects/${projectId}/secrets/${secretName}/versions/latest`;
//   }
// }
