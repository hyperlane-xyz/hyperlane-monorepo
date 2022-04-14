import { ethers } from 'ethers';
import { AbacusAppContracts } from './contracts';
import { MultiProvider } from './provider';
import { ChainName, ChainSubsetMap, NameOrDomain } from './types';

/**
 * Abstract class for interacting with collections of contracts on multiple
 * chains.
 */
export abstract class AbacusApp<
  Networks extends ChainName,
  Addresses,
  Contracts extends AbacusAppContracts<Addresses>,
> extends MultiProvider {
  protected contracts: Map<number, Contracts>;

  constructor(addresses: ChainSubsetMap<Networks, Addresses>) {
    super();
    this.contracts = new Map();
    for (const [chain, address] of Object.entries<Addresses>(addresses)) {
      const domain = this.resolveDomain(chain as Networks);
      this.contracts.set(domain, this.buildContracts(address));
    }
  }

  // TODO: make this generic
  abstract buildContracts(addresses: Addresses): Contracts;

  getContracts(nameOrDomain: NameOrDomain) {
    return this.getFromMap(nameOrDomain, this.contracts);
  }

  mustGetContracts(nameOrDomain: NameOrDomain) {
    return this.mustGetFromMap(nameOrDomain, this.contracts, 'Contracts');
  }

  /**
   * Ensure that the contracts on a given domain are connected to the
   * currently-registered signer or provider.
   *
   * @param domain the domain to reconnect
   */
  private reconnect(domain: number) {
    const connection = this.getConnection(domain);
    if (!connection) {
      throw new Error(`Reconnect failed: no connection for ${domain}`);
    }
    this.mustGetContracts(domain).connect(connection);
  }

  /**
   * Register an ethers Provider for a specified domain.
   *
   * @param nameOrDomain A domain name or number.
   * @param provider An ethers Provider to be used by requests to that domain.
   */
  registerProvider(
    nameOrDomain: NameOrDomain,
    provider: ethers.providers.Provider,
  ): void {
    const domain = this.resolveDomain(nameOrDomain);
    super.registerProvider(domain, provider);
    this.reconnect(domain);
  }

  /**
   * Register an ethers Signer for a specified domain.
   *
   * @param nameOrDomain A domain name or number.
   * @param signer An ethers Signer to be used by requests to that domain.
   */
  registerSigner(nameOrDomain: NameOrDomain, signer: ethers.Signer): void {
    const domain = this.resolveDomain(nameOrDomain);
    super.registerSigner(domain, signer);
    this.reconnect(domain);
  }

  /**
   * Remove the registered ethers Signer from a domain. This function will
   * attempt to preserve any Provider that was previously connected to this
   * domain.
   *
   * @param nameOrDomain A domain name or number.
   */
  unregisterSigner(nameOrDomain: NameOrDomain): void {
    const domain = this.resolveDomain(nameOrDomain);
    super.unregisterSigner(domain);
    this.reconnect(domain);
  }

  /**
   * Clear all signers from all registered domains.
   */
  clearSigners(): void {
    super.clearSigners();
    this.domainNumbers.forEach((domain) => this.reconnect(domain));
  }
}
