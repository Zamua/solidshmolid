// The slice of Durable Object SQLite storage the adapters use, so they run on
// node:sqlite in tests too.

export interface SqlRunner {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export type Transactor = <T>(fn: () => T) => T;
