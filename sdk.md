After doing some digging, I'd propose the following structure:

### Utils
Dependencies: None
Description: Contains shared utility functions, as at present

### SDK
Dependencies: `@abacus-network/[utils, core, apps]`
Description: The SDK provides a set of common classes that can be subclassed by App developers when building their app.

common/
- `Domain`
  - `id: number`
  -  `name: ChainName`
  - `paginate?: Pagination`
- `domains.ts` - `Domain` for each supported network
- `MultiProvider`
  - `public domains: Partial<Record<ChainName, Domain>>`
  - `public providers: Partial<Record<ChainName, Provider>>`
  - `public signers: Partial<Record<ChainName, ethers.Signer>>`
- `BeaconProxy` 
- `AbacusAppContracts<T>`
  - `public connection?: ProviderOrSigner`
  - `constructor(public readonly addresses: T)`
  - `toJson(): string`
  - `connect(connection: ProviderOrSigner)`
  - Getters that return `ethers.Contract` connected to `this.connection`. This allows for construction in the absence of a provider
- `AbacusApp<V extends AbacusAppContracts<T>> extends MultiProvider`
  - `public readonly contracts: Partial<Record<ChainName, V>>`
  - `constructor(addresses: Partial<Record<ChainName, T>>`
  - Should this do event fetching?
  - AnnotatedEvent? 

router/
- `RouterAppContracts extends AbacusAppContracts<any>`
  - `abstract router: Router`
 
App developers define the following:
- `type MyAppContractAddresses`
- `MyAppContracts extends AbacusAppContracts<MyAppContractAddresses>`
- `MyApp extends AbacusApp<MyAppContracts>`

The SDK also provides an `Abacus` object that follows this pattern. First, the pattern is followed for all Abacus "submodules", currently `core`, `governance`, and `bridge`. Then the those objects are combined to create a single `Abacus` object that follows the same pattern.

Per-environment addresses files allow concrete instances of the `Abacus` object to be exported, to be consumed by app developers.

Note that consumers are expected to provide connections (i.e. provider or signer), none are exported from the SDK.

abacus/
  - core/                                                                        
    - `CoreContractAddresses`                                                
    - `CoreContracts extends AbacusAppContracts<CoreContractAddresses>`
  - governance/                                                                  
    - `GovernanceContractAddresses`                                        
    - `GovernanceContracts extends AbacusAppContracts<GovernanceContractAddresses>`
  - bridge/                                                                      
    - `BridgeContractAddresses`                                                   
    - `BridgeContracts extends AbacusAppContracts<BridgeContractAddresses>`     
  - `AbacusContractAddresses` - `CoreContractAddresses + GovernanceContractAddresses + BridgeContractAddresses`
  - `AbacusContracts extends AbacusAppContracts<AbacusContractAddresses>`
    - `public core: CoreContracts`
    - `public governance: GovernanceContracts`
    - `public BridgeContracts`
  - `Abacus extends AbacusApp<AbacusContracts>`
  - Everything else currently in `sdk/abacus/[events, govern, messages, tokens]`
  - `index.ts`
    - `import { localAddresses } from './environments/local'`
    - `export local = new Abacus(localAddresses)`
  - environments/
    - local/
      - `index.ts`
        - `imports { core } from './core'`
        - `imports { bridge } from './bridge'`
        - `imports { governance } from './governance'`
        - `exports localAddresses: Partial<Record<ChainName, AbacusContractAddresses>>`
      - `core.ts`
        - `exports core: Partial<Record<ChainName, CoreContractAddresses>>`
      - `governance.ts`
        - `exports governance: Partial<Record<ChainName, GovernanceContractAddresses>>`
      - `bridge.ts`
        - `exports bridge: Partial<Record<ChainName, BridgeContractAddresses>>`             

 ### Deploy
Dependencies: `@abacus-network/[utils, core, apps, sdk]`
Description: Deploy extends the classes in the SDK to be used for contract deployment. Consumers can subclass these to use for multi-chain app deployment.

common/
- `TransactionConfig`
  - `overrides: ethers.Overrides`
  - `signer: ethers.Signer`
  - `confirmations?: number`
- `ChainConfig`
  - `domain: Domain`
  - `tx: TransactionConfig`
- `AbacusAppDeploy<T, V, C> extends AbacusApp<T, V>`
  - `constructor(chains: Partial<Record<ChainName, ChainConfig>>)`
  - `abstract deployContracts(name: ChainName): Promise<T>`
  - `abstract deploy(config: C)`
  - `writeContracts(directory: string)`
  - `writeVerificationInput(directory: string)`
- `ContractVerifier`
- `InvariantChecker`
router/
- `RouterAppDeploy<V extends RouterAppContracts, T, C> extends AbacusAppDeploy<V, T, C>`
  - `async enrollRouters()`
- `RouterInvariantChecker`

 ### Infra
Dependencies: `@abacus-network/[utils, core, apps, deploy]`
Description: Infra contains everything needed for Abacus Labs to deploy and maintain one or more Abacus deployments. This includes:
- Config
  - `TransactionConfigs` for each network
  - `[Core | Governance | Bridge | Agent | Infrastructure]Configs` for each environment
- Subclasses of the following for the three Abacus modules: `core`, `governance`, and `bridge`
  - `AbacusAppDeploy`
  - `InvariantChecker`
- The current contents of `deploy/src/[agents | infrastructure]
- The current contents of `deploy/scripts/`
