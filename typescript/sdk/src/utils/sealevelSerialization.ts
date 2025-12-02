export class SealevelInstructionWrapper<Instr> {
  instruction!: number;
  data!: Instr;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export class SealevelAccountDataWrapper<T> {
  initialized!: boolean;
  discriminator?: unknown;
  data!: T;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export function getSealevelAccountDataSchema<T>(
  DataClass: T,
  discriminator?: any,
) {
  return {
    kind: 'struct',
    fields: [
      ['initialized', 'u8'],
      ...(discriminator ? [['discriminator', discriminator]] : []),
      ['data', DataClass],
    ],
  };
}

// The format of simulation return data from the Sealevel programs.
// A trailing non-zero byte was added due to a bug in Sealevel RPCs that would
// truncate responses with trailing zero bytes.
export class SealevelSimulationReturnData<T> {
  return_data!: T;
  trailing_byte!: number;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export function getSealevelSimulationReturnDataSchema<T>(DataClass: T) {
  return {
    kind: 'struct',
    fields: [
      ['data', DataClass],
      ['trailing_byte', 'u8'],
    ],
  };
}
