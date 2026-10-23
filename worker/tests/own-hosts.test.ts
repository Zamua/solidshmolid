import { describe, expect, it } from 'vitest';
import type { Env } from '../runtime/env.js';
import { withOwnHosts } from '../runtime/ownHosts.js';

const env = { APEX_HOST: 'stg.example.com', POD_HOST_TEMPLATE: '{handle}-stg.pods.example' } as Env;

describe('fetching our own hosts', () => {
  it('serves the apex and our pod hosts in-process, everything else over the network', async () => {
    const served: string[] = [];
    const sent: string[] = [];
    const fetch = withOwnHosts(
      env,
      '',
      async (r) => (served.push(r.url), new Response('in-process')),
      async (u) => (sent.push(u), new Response('network')),
    );
    expect(await (await fetch('https://stg.example.com/.oidc/jwks')).text()).toBe('in-process');
    expect(await (await fetch('https://k3x9fqm7-stg.pods.example/profile/card')).text()).toBe('in-process');
    expect(await (await fetch('https://solidcommunity.net/profile/card')).text()).toBe('network');
    expect(await (await fetch('https://k3x9fqm7.pods.example/profile/card')).text()).toBe('network');
    expect(await (await fetch('https://stg.example.com:3000/.oidc/jwks')).text()).toBe('network');
    expect(served).toEqual(['https://stg.example.com/.oidc/jwks', 'https://k3x9fqm7-stg.pods.example/profile/card']);
    expect(sent).toEqual(['https://solidcommunity.net/profile/card', 'https://k3x9fqm7.pods.example/profile/card', 'https://stg.example.com:3000/.oidc/jwks']);
  });
});
