export interface IMutex {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export class Mutex implements IMutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
