import { describe, expect, it } from 'vitest';
import { NO_ACTIVITY } from '../app/shared/activity.js';
import { AnalyticsActivity } from '../runtime/adapters/activity.js';
import { activity } from '../runtime/composition.js';
import type { Env } from '../runtime/env.js';
import { hostsFor } from '../runtime/hosts.js';

type Point = { indexes: string[]; blobs: string[]; doubles: number[] };

function dataset() {
  const points: Point[] = [];
  return { points, writeDataPoint: (p: Point) => void points.push(p) };
}

describe('activity data points', () => {
  it('writes one index, the app, action and detail, and a count of one', async () => {
    const d = dataset();
    await new AnalyticsActivity(d, 'salt-a').record({ actor: 'k3x9fqm7', action: 'storage_linked', detail: 'dropbox' });
    expect(d.points).toHaveLength(1);
    expect(d.points[0]!.blobs).toEqual(['solidshmolid', 'storage_linked', 'dropbox']);
    expect(d.points[0]!.doubles).toEqual([1]);
    expect(d.points[0]!.indexes).toHaveLength(1);
  });

  it('indexes active by the bare actor and every other action by actor and action', async () => {
    const d = dataset();
    const a = new AnalyticsActivity(d, 'salt-a');
    await a.record({ actor: 'k3x9fqm7', action: 'active' });
    await a.record({ actor: 'k3x9fqm7', action: 'signup' });
    await a.record({ actor: null, action: 'pod_request', detail: 'public' });
    const [active, signup, served] = d.points.map((p) => p.indexes[0]!);
    expect(signup).toBe(`${active}:signup`);
    expect(served).toBe('-:pod_request');
  });

  it('indexes by a 16-hex keyed hash: stable per actor and salt, never the id itself', async () => {
    const d = dataset();
    const a = new AnalyticsActivity(d, 'salt-a');
    await a.record({ actor: 'k3x9fqm7', action: 'active' });
    await a.record({ actor: 'k3x9fqm7', action: 'active' });
    await a.record({ actor: 'p8w2hnc4', action: 'active' });
    await new AnalyticsActivity(d, 'salt-b').record({ actor: 'k3x9fqm7', action: 'active' });
    const [first, again, other, resalted] = d.points.map((p) => p.indexes[0]!);
    expect(first).toMatch(/^[0-9a-f]{16}$/u);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(resalted).not.toBe(first);
    expect(JSON.stringify(d.points)).not.toContain('k3x9fqm7');
  });

  it('matches HMAC-SHA256 of "<app>:<id>" under the salt', async () => {
    const d = dataset();
    await new AnalyticsActivity(d, 'salt-a').record({ actor: 'k3x9fqm7', action: 'active' });
    const { createHmac } = await import('node:crypto');
    expect(d.points[0]!.indexes[0]).toBe(createHmac('sha256', 'salt-a').update('solidshmolid:k3x9fqm7').digest('hex').slice(0, 16));
  });

  it('writes "-" when nobody in particular acted', async () => {
    const d = dataset();
    await new AnalyticsActivity(d, 'salt-a').record({ actor: null, action: 'active' });
    expect(d.points[0]!.indexes).toEqual(['-']);
  });

  it('swallows a failing write', async () => {
    const broken = { writeDataPoint: () => { throw new Error('down'); } };
    await expect(new AnalyticsActivity(broken, 'salt-a').record({ actor: 'k3x9fqm7', action: 'active' })).resolves.toBeUndefined();
  });

  it('is off unless the deployment has both the dataset and the salt', () => {
    const d = dataset();
    expect(activity({} as Env)).toBe(NO_ACTIVITY);
    expect(activity({ ACTIVITY: d } as unknown as Env)).toBe(NO_ACTIVITY);
    expect(activity({ ACTIVITY_SALT: 's' } as Env)).toBe(NO_ACTIVITY);
    expect(activity({ ACTIVITY: d, ACTIVITY_SALT: 's' } as unknown as Env)).toBeInstanceOf(AnalyticsActivity);
  });
});

describe('whose WebID a token names', () => {
  const hosts = hostsFor({ POD_HOST_TEMPLATE: '{handle}.pods.example', APEX_HOST: 'id.example' } as Env, new URL('https://id.example/'));

  it('is a pod here only for exactly the WebID that pod serves', () => {
    expect(hosts.podOfWebid('https://k3x9fqm7.pods.example/profile/card#me')).toBe('k3x9fqm7');
    expect(hosts.podOfWebid('https://k3x9fqm7.pods.example/other#me')).toBeNull();
    expect(hosts.podOfWebid('http://k3x9fqm7.pods.example/profile/card#me')).toBeNull();
    expect(hosts.podOfWebid('https://dana.pods.example/profile/card#me')).toBeNull();
    expect(hosts.podOfWebid('https://k3x9fqm7.elsewhere.example/profile/card#me')).toBeNull();
    expect(hosts.podOfWebid('not a url')).toBeNull();
  });
});
