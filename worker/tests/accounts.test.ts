import { describe, expect, it } from 'vitest';
import { Accounts, LinkExpired, NoStorageYet, NotSignedUp } from '../app/accounts/accounts.js';
import type { AccountRepository, AccountState, Directory, LinkSummary, PendingLink, Placement, PodRecord, Pods } from '../app/accounts/ports.js';
import type { StorageAuthorization } from '../app/storage/ports.js';

class MemoryAccount implements AccountRepository {
  state: AccountState | null = null;
  refreshTokens = new Map<string, string>();
  pending = new Map<string, PendingLink>();
  async load() {
    return this.state && structuredClone(this.state);
  }
  async create(state: AccountState) {
    this.state ??= structuredClone(state);
    return structuredClone(this.state);
  }
  async addPod(pod: PodRecord) {
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
  keys = new Map<string, string>();
  podIds = new Map<string, string>();
  async accountKeyFor(person: string) {
    if (!this.keys.has(person)) this.keys.set(person, `key-${person}`);
    return this.keys.get(person)!;
  }
  async allocatePodId(accountKey: string) {
    const id = `pod${this.podIds.size + 1}`.padEnd(8, 'x');
    this.podIds.set(id, accountKey);
    return id;
  }
}

function world() {
  const accounts = new Map<string, MemoryAccount>();
  const directory = new MemoryDirectory();
  const placed: { podId: string; placement: Placement; owner: string; withProfile: boolean }[] = [];
  const declared: { webidPodId: string; owner: string; storagePodId: string }[] = [];
  const pods: Pods = {
    place: async (podId, placement, owner, withProfile) => {
      placed.push({ podId, placement, owner, withProfile });
      return 'created';
    },
    declareStorage: async (webidPodId, owner, storagePodId) => void declared.push({ webidPodId, owner, storagePodId }),
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
  const service = new Accounts({
    directory,
    account: (key) => {
      if (!accounts.has(key)) accounts.set(key, new MemoryAccount());
      return accounts.get(key)!;
    },
    pods,
    identities: { bind: async (person, webid) => void bound.set(person, webid) },
    authorization,
    ids: { random: () => `r${++n}` },
    webidOf: (podId) => `https://${podId}.pods.example/profile/card#me`,
  });
  return { service, accounts, directory, placed, declared, bound };
}

const stateOf = (url: string) => new URL(url).searchParams.get('state')!.split('.') as [string, string];

async function connected(person = 'user_dana') {
  const w = world();
  await w.service.signup(person);
  const [key, nonce] = stateOf(await w.service.beginLink(person, 'https://x/cb'));
  const state = await w.service.completeLink(person, key, nonce, 'code', 'https://x/cb');
  return { ...w, state };
}

describe('signing up', () => {
  it('gives the person a WebID and a first pod waiting for storage', async () => {
    const { service, bound } = world();
    const a = await service.signup('user_dana');
    expect(a).toEqual({ key: 'key-user_dana', webid: 'https://pod1xxxx.pods.example/profile/card#me', pods: [{ podId: 'pod1xxxx', linkId: null, folder: 'pod1xxxx' }], links: [] });
    expect(bound.get('user_dana')).toBe(a.webid);
  });

  it('is idempotent: signing up again returns the same account and pod', async () => {
    const { service, directory } = world();
    const first = await service.signup('user_dana');
    expect(await service.signup('user_dana')).toEqual(first);
    expect(directory.podIds.size).toBe(1);
  });
});

describe('connecting storage', () => {
  it('places the first pod in its own folder, with the WebID profile', async () => {
    const { state, placed } = await connected();
    expect(state.links).toEqual([{ linkId: expect.any(String), provider: 'dropbox', account: 'dbid:1' }]);
    expect(state.pods[0]!.linkId).toBe(state.links[0]!.linkId);
    expect(placed).toEqual([
      { podId: 'pod1xxxx', placement: { accountKey: state.key, linkId: state.links[0]!.linkId, provider: 'dropbox', folder: 'pod1xxxx' }, owner: state.webid, withProfile: true },
    ]);
  });

  it('keeps the refresh token inside the account', async () => {
    const { state, accounts } = await connected();
    expect(JSON.stringify(state)).not.toContain('refresh1');
    expect(accounts.get(state.key)!.refreshTokens.get(state.links[0]!.linkId)).toBe('refresh1');
  });

  it('refuses someone who has not signed up', async () => {
    const { service } = world();
    await expect(service.beginLink('user_nobody', 'https://x/cb')).rejects.toThrow(NotSignedUp);
  });

  it('refuses a callback it did not start, a replay, and a callback finished by someone else', async () => {
    const { service } = world();
    await service.signup('user_dana');
    await service.signup('user_eve');
    const [key, nonce] = stateOf(await service.beginLink('user_dana', 'https://x/cb'));
    await expect(service.completeLink('user_dana', key, 'nope', 'code', 'https://x/cb')).rejects.toThrow(LinkExpired);
    await expect(service.completeLink('user_eve', key, nonce, 'code', 'https://x/cb')).rejects.toThrow(LinkExpired);
    await service.completeLink('user_dana', key, nonce, 'code', 'https://x/cb');
    await expect(service.completeLink('user_dana', key, nonce, 'code', 'https://x/cb')).rejects.toThrow(LinkExpired);
  });

  it('does not place a pod twice when a second link is connected', async () => {
    const { service, placed } = await connected();
    const [key, nonce] = stateOf(await service.beginLink('user_dana', 'https://x/cb'));
    await service.completeLink('user_dana', key, nonce, 'code', 'https://x/cb');
    expect(placed).toHaveLength(1);
  });
});

describe('adding a pod', () => {
  it('places it beside the first pod, owned by the same WebID, and lists it in the profile', async () => {
    const { service, state, placed, declared } = await connected();
    const after = await service.addPod('user_dana');
    expect(after.pods.map((p) => p.podId)).toEqual(['pod1xxxx', 'pod2xxxx']);
    expect(after.pods[1]).toEqual({ podId: 'pod2xxxx', linkId: state.links[0]!.linkId, folder: 'pod2xxxx' });
    expect(placed.at(-1)).toEqual({
      podId: 'pod2xxxx',
      placement: { accountKey: state.key, linkId: state.links[0]!.linkId, provider: 'dropbox', folder: 'pod2xxxx' },
      owner: state.webid,
      withProfile: false,
    });
    expect(declared).toEqual([{ webidPodId: 'pod1xxxx', owner: state.webid, storagePodId: 'pod2xxxx' }]);
  });

  it('needs an account with storage connected', async () => {
    const { service, directory } = world();
    await expect(service.addPod('user_dana')).rejects.toThrow(NotSignedUp);
    await service.signup('user_dana');
    await expect(service.addPod('user_dana')).rejects.toThrow(NoStorageYet);
    expect(directory.podIds.size).toBe(1);
  });
});
