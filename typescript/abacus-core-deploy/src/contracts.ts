import fs from 'fs';
import path from 'path';

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
    const dir = path.dirname(filepath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, this.toJsonPretty());
  }
}
