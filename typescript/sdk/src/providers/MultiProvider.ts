import { Signer, ethers } from 'ethers';

import { ChainMap, ChainName, IChainConnection, Remotes } from '../types';
import { MultiGeneric } from '../utils/MultiGeneric';
import { objMap, pick } from '../utils/objects';

import { ChainConnection } from './ChainConnection';

export class MultiProvider<
  Chain extends ChainName = ChainName,
> extends MultiGeneric<Chain, ChainConnection> {
  constructor(chainConnectionConfigs: ChainMap<Chain, IChainConnection>) {
    super(
      objMap(
        chainConnectionConfigs,
        (_, connection) => new ChainConnection(connection),
      ),
    );
  }

  /**
   * Get chainConnection for a chain
   * @throws if chain is invalid or has not been set
   */
  getChainConnection(chain: Chain): ChainConnection {
    return this.get(chain);
  }

  /**
   * Get chainConnection for a chain
   * @returns value or null if chain value has not been set
   */
  tryGetChainConnection(chain: Chain): ChainConnection | null {
    return this.tryGet(chain);
  }

  /**
   * Set value for a chain
   * @throws if chain is invalid or has not been set
   */
  setChainConnection(
    chain: Chain,
    chainConnectionConfig: IChainConnection,
  ): ChainConnection {
    const connection = new ChainConnection(chainConnectionConfig);
    return this.set(chain, connection);
  }

  /**
   * Get provider for a chain
   * @throws if chain is invalid or has not been set
   */
  getChainProvider(chain: Chain): ethers.providers.Provider {
    const chainConnection = this.get(chain);
    if (!chainConnection.provider) {
      throw new Error(`No provider set for chain ${chain}`);
    }
    return chainConnection.provider;
  }

  /**
   * Get provider for a chain
   * @returns value or null if chain value has not been set
   */
  tryGetChainProvider(chain: Chain): ethers.providers.Provider | null {
    return this.tryGet(chain)?.provider ?? null;
  }

  /**
   * Get signer for a chain
   * @throws if chain is invalid or has not been set
   */
  getChainSigner(chain: Chain): ethers.Signer {
    const chainConnection = this.get(chain);
    if (!chainConnection.signer) {
      throw new Error(`No signer set for chain ${chain}`);
    }
    return chainConnection.signer;
  }

  /**
   * Get signer for a chain
   * @returns value or null if chain value has not been set
   */
  tryGetChainSigner(chain: Chain): ethers.Signer | null {
    return this.tryGet(chain)?.signer ?? null;
  }

  /**
   * Create a new MultiProvider which includes the provided chain connection config
   */
  extendWithChain<New extends Remotes<ChainName, Chain>>(
    chain: New,
    chainConnectionConfig: IChainConnection,
  ): MultiProvider<New & Chain> {
    const connection = new ChainConnection(chainConnectionConfig);
    return new MultiProvider<New & Chain>({
      ...this.chainMap,
      [chain]: connection,
    });
  }

  /**
   * Create a new MultiProvider from the intersection
   * of current's chains and the provided chain list
   */
  intersect<IntersectionChain extends Chain>(
    chains: ChainName[],
  ): {
    intersection: IntersectionChain[];
    multiProvider: MultiProvider<IntersectionChain>;
  } {
    const ownChains = this.chains();
    const intersection = ownChains.filter((c) =>
      chains.includes(c),
    ) as IntersectionChain[];

    if (!intersection.length) {
      throw new Error(`No chains shared between MultiProvider and list`);
    }

    const intersectionChainMap = pick(this.chainMap, intersection);

    const multiProvider = new MultiProvider<IntersectionChain>({
      ...intersectionChainMap,
    });
    return { intersection, multiProvider };
  }

  rotateSigner(newSigner: Signer): void {
    this.forEach((chain, dc) => {
      this.setChainConnection(chain, {
        ...dc,
        signer: newSigner.connect(dc.provider),
      });
    });
  }

  // This doesn't work on hardhat providers so we skip for now
  // ready() {
  //   return Promise.all(this.values().map((dc) => dc.provider!.ready));
  // }
}
