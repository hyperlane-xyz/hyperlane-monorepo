import fs from 'fs';

export abstract class Contracts<T> {
  constructor() {}

  abstract toObject(): T;

  toJson(): string {
    return JSON.stringify(this.toObject());
  }

  toJsonPretty(): string {
    return JSON.stringify(this.toObject(), null, 2);
  }

  writeJson(filepath: string) {
    fs.writeFileSync(filepath, this.toJsonPretty());
  }
}
