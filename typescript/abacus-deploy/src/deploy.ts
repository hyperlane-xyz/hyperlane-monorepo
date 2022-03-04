// TODO(asa): Can T extend Instance?
export abstract class Deploy <T> {
  constructor(public readonly instances: Record<number, T>) {}
}
