export type ScraperDbRow = Record<string, unknown>;

export type ScraperDbDatabase = {
  query(text: string, values?: unknown[]): Promise<ScraperDbRow[]>;
};
