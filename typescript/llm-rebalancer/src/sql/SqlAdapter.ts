export type SqlParams = ReadonlyArray<unknown>;
export type SqlRow = Record<string, unknown>;

export interface SqlAdapter {
  query<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): Promise<T[]>;
  exec(sql: string, params?: SqlParams): Promise<void>;
  transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
