import { ChainConfig, Domain } from './types'

// TODO(asa): Can T extend Instance?
export abstract class Deploy<T> {
  constructor(public readonly instances: Record<number, T>, public readonly chains: Record<number, ChainConfig>) {}

  signer(domain: Domain) {
    return this.chains[domain].signer;
  }

  get domains(): Domain[] {
    return Object.keys(this.instances).map((d) => parseInt(d))
  }
}
