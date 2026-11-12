// Stands in for `cloudflare:workers` on node: enough for the Durable Object
// classes to load. Tests that drive the Worker hand it fake namespaces, so
// these classes are never constructed.
export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}
