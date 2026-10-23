import { describe, expect, it } from 'vitest';
import { Households, LinkExpired, NoStorageYet, NotAManager } from '../app/households/households.js';
import type { Directory, HouseholdRepository, HouseholdState, LinkSummary, Logins, PendingLink, PodPlacement, Placement, Pods } from '../app/households/ports.js';
import { HouseholdRuleBroken, type Member } from '../domain/households/household.js';
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
  failNextAdd = false;
  async addMember(member: Member, pod: PodPlacement) {
    if (this.failNextAdd) {
      this.failNextAdd = false;
      throw new Error('storage hiccup');
    }
    this.state!.members.push(member);
    this.state!.pods.push(pod);
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
  const created: { person: string; username: string; name: string }[] = [];
  const removed: string[] = [];
  const logins = {
    created,
    removed,
    createManaged: async (username: string, name: string) => {
      const person = `user_m${created.length + 1}`;
      created.push({ person, username, name });
      return person;
    },
    remove: async (person: string) => void removed.push(person),
    nameOf: async (person: string) => (person === 'user_dana' ? 'Dana' : null),
  } satisfies Logins & { created: unknown; removed: unknown };
  let n = 0;
  const service = new Households({
    directory,
    household: (id) => {
      if (!households.has(id)) households.set(id, new MemoryHousehold());
      return households.get(id)!;
    },
    pods,
    identities: { bind: async (person, webid) => void bound.set(person, webid) },
    logins,
    authorization,
    ids: { random: () => `r${++n}` },
    webidOf: (podId) => `https://${podId}.pods.example/profile/card#me`,
  });
  return { service, households, directory, placed, bound, logins };
}

const stateOf = (url: string) => new URL(url).searchParams.get('state')!.split('.') as [string, string];

describe('signing up', () => {
  it('gives the person a household they manage and a pod waiting for storage', async () => {
    const { service, bound } = world();
    const h = await service.signup('user_dana');
    expect(h.members).toEqual([
      { clerkUserId: 'user_dana', role: 'manager', kind: 'adult', name: 'Dana', webid: 'https://pod1xxxx.pods.example/profile/card#me', handle: 'pod1xxxx' },
    ]);
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

describe('adding a managed member', () => {
  async function connected() {
    const w = world();
    await w.service.signup('user_dana');
    const [id, nonce] = stateOf(await w.service.beginLink('user_dana', 'https://x/cb'));
    const h = await w.service.completeLink('user_dana', id, nonce, 'code', 'https://x/cb');
    return { ...w, h };
  }

  it('gives them their own login, WebID and pod beside the manager, owned by them', async () => {
    const { service, h, placed, bound, logins, directory } = await connected();
    const after = await service.addManagedMember('user_dana', '  Leo ');
    const leo = after.members.find((m) => m.name === 'Leo')!;
    expect(leo).toEqual({ clerkUserId: 'user_m1', role: 'member', kind: 'managed', name: 'Leo', webid: 'https://pod2xxxx.pods.example/profile/card#me', handle: 'pod2xxxx' });
    expect(logins.created).toEqual([{ person: 'user_m1', username: 'pod-pod2xxxx', name: 'Leo' }]);
    expect(bound.get('user_m1')).toBe(leo.webid);
    expect(await directory.householdOf('user_m1')).toBe(h.id);
    expect(after.pods.find((p) => p.owner === 'user_m1')).toEqual({ podId: 'pod2xxxx', owner: 'user_m1', linkId: h.links[0]!.linkId, folder: 'pod2xxxx' });
    expect(placed.at(-1)).toEqual({
      podId: 'pod2xxxx',
      placement: { householdId: h.id, linkId: h.links[0]!.linkId, provider: 'dropbox', folder: 'pod2xxxx' },
      owner: leo.webid,
      managers: [h.members[0]!.webid],
    });
  });

  it('is for managers only, after storage is connected, with a real name', async () => {
    const { service } = await connected();
    await expect(service.addManagedMember('user_dana', '   ')).rejects.toThrow(HouseholdRuleBroken);
    await service.addManagedMember('user_dana', 'Leo');
    await expect(service.addManagedMember('user_m1', 'Mallory')).rejects.toThrow(NotAManager);
    const fresh = world();
    await fresh.service.signup('user_eve');
    await expect(fresh.service.addManagedMember('user_eve', 'Kid')).rejects.toThrow(NoStorageYet);
    expect(fresh.logins.created).toEqual([]);
  });

  it('removes the login it made when the household cannot record the member', async () => {
    const { service, households, h, logins } = await connected();
    households.get(h.id)!.failNextAdd = true;
    await expect(service.addManagedMember('user_dana', 'Leo')).rejects.toThrow('storage hiccup');
    expect(logins.removed).toEqual(['user_m1']);
    expect((await service.mine('user_dana'))!.members).toHaveLength(1);
  });
});
