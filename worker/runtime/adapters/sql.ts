// The slice of Durable Object SQLite storage the adapters use, so they run on
// node:sqlite in tests too.

export interface SqlRunner {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export type Transactor = <T>(fn: () => T) => T;

/** Adds a column to a table that may predate it; one that has it already is
 * left alone. */
export function addColumn(sql: SqlRunner, table: string, column: string): void {
  try {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  } catch (e) {
    if (!/duplicate column/iu.test((e as Error).message)) throw e;
  }
}
