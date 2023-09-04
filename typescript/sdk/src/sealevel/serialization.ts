/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
export class SealevelInstructionWrapper<Instr> {
  instruction!: number;
  data!: Instr;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export class SealevelAccountDataWrapper<T> {
  initialized!: boolean;
  data!: T;
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export function getSealevelAccountDataSchema<T>(DataClass: T) {
  return {
    kind: 'struct',
    fields: [
      ['initialized', 'u8'],
      ['data', DataClass],
    ],
  };
}
