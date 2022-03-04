import { Domain } from './types'

// TODO(asa): Can T extend Instance?
export abstract class Deploy<T> {
  constructor(public readonly instances: Record<number, T>) {}
  get domains(): Domain[] {
    return Object.keys(this.instances).map((d) => parseInt(d))
  }
}
