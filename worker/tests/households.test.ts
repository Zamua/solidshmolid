import { describe, expect, it } from 'vitest';
import { Households, LinkExpired, NotAManager } from '../app/households/households.js';
import type { Directory, HouseholdRepository, HouseholdState, LinkSummary, PendingLink, Placement, Pods } from '../app/households/ports.js';
import type { StorageAuthorization } from '../app/storage/ports.js';

class MemoryHousehold implements HouseholdRepository {
  state: HouseholdState | null = null;
  refreshTokens = new Map<string, string>();
  pending = new Map<string, PendingLink>();
  async load() {
    return this.state && structuredClone(this.state);
  }
  async create(state: HouseholdState) {
    this.state ??= structuredClone(state);
    return structuredClone(this.state);
  }
  async addLink(link: LinkSummary, refreshToken: string) {
    this.state!.links.push(link);
    this.refreshTokens.set(link.linkId, refreshToken);
  }
  async placePod(podId: string, linkId: string) {
    this.state!.pods.find((p) => p.podId === podId)!.linkId = linkId;
  }
  async rememberPending(nonce: string, p: PendingLink) {
    this.pending.set(nonce, p);
  }
  async takePending(nonce: string) {
    const p = this.pending.get(nonce) ?? null;
    this.pending.delete(nonce);
    return p;
  }
}

class MemoryDirectory implements Directory {
  members = new Map<string, string>();
  podIds = new Map<string, string>();
  async householdOf(person: string) {
    return this.members.get(person) ?? null;
  }
  async join(person: string, householdId: string) {
    if (!this.members.has(person)) this.members.set(person, householdId);
    return this.members.get(person)!;
  }
  async allocatePodId(householdId: string) {
    const id = `pod${this.podIds.size + 1}`.padEnd(8, 'x');
    this.podIds.set(id, householdId);
    return id;
  }
}

function world() {
  const households = new Map<string, MemoryHousehold>();
  const directory = new MemoryDirectory();
  const placed: { podId: string; placement: Placement; owner: string; managers: string[] }[] = [];
  const pods: Pods = {
    place: async (podId, placement, owner, managers) => {
      placed.push({ podId, placement, owner, managers });
      return 'created';
    },
  };
  const bound = new Map<string, string>();
  const authorization: StorageAuthorization = {
    provider: 'dropbox',
    pkce: async () => ({ verifier: 'v1', challenge: 'c1' }),
    authorizeUrl: (redirect, state, challenge) => `https://dropbox.example/authorize?state=${state}&c=${challenge}&r=${redirect}`,
    exchange: async (code, verifier) => {
      if (code !== 'code' || verifier !== 'v1') throw new Error('bad exchange');
      return { refreshToken: 'refresh1', accountId: 'dbid:1', accessToken: 'a', expiresAt: 0 };
    },
  };
  let n = 0;
  const service = new Households({
    directory,
    household: (id) => {
      if (!households.has(id)) households.set(id, new MemoryHousehold());
      return households.get(id)!;
    },
    pods,
    identities: { bind: async (person, webid) => void bound.set(person, webid) },
    authorization,
    ids: { random: () => `r${++n}` },
    webidOf: (podId) => `https://${podId}.pods.example/profile/card#me`,
  });
  return { service, households, directory, placed, bound };
}

const stateOf = (url: string) => new URL(url).searchParams.get('state')!.split('.') as [string, string];

describe('signing up', () => {
  it('gives the person a household they manage and a pod waiting for storage', async () => {
    const { service, bound } = world();
    const h = await service.signup('user_dana');
    expect(h.members).toEqual([{ clerkUserId: 'user_dana', role: 'manager', webid: 'https://pod1xxxx.pods.example/profile/card#me', handle: 'pod1xxxx' }]);
    expect(h.pods).toEqual([{ podId: 'pod1xxxx', owner: 'user_dana', linkId: null, folder: 'pod1xxxx' }]);
    expect(bound.get('user_dana')).toBe('https://pod1xxxx.pods.example/profile/card#me');
  });

  it('is idempotent: signing up again returns the same household and pod', async () => {
    const { service, directory } = world();
    const first = await service.signup('user_dana');
    expect(await service.signup('user_dana')).toEqual(first);
    expect(directory.podIds.size).toBe(1);
  });

  it('gives different people different households and pods', async () => {
    const { service } = world();
    const a = await service.signup('user_a');
    const b = await service.signup('user_b');
    expect(a.id).not.toBe(b.id);
    expect(a.pods[0]!.podId).not.toBe(b.pods[0]!.podId);
  });
});

describe('connecting storage', () => {
  it('places every waiting pod in its own folder of the new link', async () => {
    const { service, placed } = world();
    const h = await service.signup('user_dana');
    const url = await service.beginLink('user_dana', 'https://pods.example/link/dropbox/callback');
    const [householdId, nonce] = stateOf(url);
    expect(householdId).toBe(h.id);
    const after = await service.completeLink('user_dana', householdId, nonce, 'code', 'https://pods.example/link/dropbox/callback');
    expect(after.links).toEqual([{ linkId: expect.any(String), provider: 'dropbox', account: 'dbid:1' }]);
    expect(after.pods[0]!.linkId).toBe(after.links[0]!.linkId);
    expect(placed).toEqual([
      {
        podId: 'pod1xxxx',
        placement: { householdId: h.id, linkId: after.links[0]!.linkId, provider: 'dropbox', folder: 'pod1xxxx' },
        owner: h.members[0]!.webid,
        managers: [h.members[0]!.webid],
      },
    ]);
  });

  it('keeps the refresh token inside the household', async () => {
    const { service, households } = world();
    await service.signup('user_dana');
    const [id, nonce] = stateOf(await service.beginLink('user_dana', 'https://x/cb'));
    const after = await service.completeLink('user_dana', id, nonce, 'code', 'https://x/cb');
    expect(JSON.stringify(after)).not.toContain('refresh1');
    expect(households.get(id)!.refreshTokens.get(after.links[0]!.linkId)).toBe('refresh1');
  });

  it('refuses someone who is not a manager, or not signed up', async () => {
    const { service } = world();
    await expect(service.beginLink('user_nobody', 'https://x/cb')).rejects.toThrow(NotAManager);
  });

  it('refuses a callback it did not start, a replay, and a callback finished by someone else', async () => {
    const { service } = world();
    await service.signup('user_dana');
    await service.signup('user_eve');
    const [id, nonce] = stateOf(await service.beginLink('user_dana', 'https://x/cb'));
    await expect(service.completeLink('user_dana', id, 'nope', 'code', 'https://x/cb')).rejects.toThrow(LinkExpired);
    await expect(service.completeLink('user_eve', id, nonce, 'code', 'https://x/cb')).rejects.toThrow(LinkExpired);
    const [id2, nonce2] = stateOf(await service.beginLink('user_dana', 'https://x/cb'));
    await service.completeLink('user_dana', id2, nonce2, 'code', 'https://x/cb');
    await expect(service.completeLink('user_dana', id2, nonce2, 'code', 'https://x/cb')).rejects.toThrow(LinkExpired);
  });

  it('does not place a pod twice when a second link is connected', async () => {
    const { service, placed } = world();
    await service.signup('user_dana');
    for (let i = 0; i < 2; i++) {
      const [id, nonce] = stateOf(await service.beginLink('user_dana', 'https://x/cb'));
      await service.completeLink('user_dana', id, nonce, 'code', 'https://x/cb');
    }
    expect(placed).toHaveLength(1);
  });
});
