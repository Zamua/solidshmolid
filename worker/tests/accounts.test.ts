import { describe, expect, it } from 'vitest';
import { Accounts, HoldsWebid, LinkExpired, NoStorageYet, NotConfirmed, NotSignedUp, StorageInUse } from '../app/accounts/accounts.js';
import { NotFound } from '../app/shared/errors.js';
import type { AccountRepository, AccountState, Directory, LinkSummary, PendingDeletion, PendingLink, Placement, PodRecord, Pods } from '../app/accounts/ports.js';
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
  async rememberLinkPending(nonce: string, p: PendingLink) {
    this.pending.set(nonce, p);
  }
  async takeLinkPending(nonce: string) {
    const p = this.pending.get(nonce) ?? null;
    this.pending.delete(nonce);
    return p;
  }
  deletions = new Map<string, PendingDeletion>();
  revokedLinks: string[] = [];
  erased = false;
  async rememberDeletion(token: string, p: PendingDeletion) {
    this.deletions.set(token, p);
  }
  async takeDeletion(token: string) {
    const p = this.deletions.get(token) ?? null;
    this.deletions.delete(token);
    return p;
  }
  async removePod(podId: string) {
    this.state!.pods = this.state!.pods.filter((p) => p.podId !== podId);
  }
  async removeLink(linkId: string) {
    this.revokedLinks.push(linkId);
    this.state!.links = this.state!.links.filter((l) => l.linkId !== linkId);
  }
  async erase() {
    this.revokedLinks.push(...this.state!.links.map((l) => l.linkId));
    this.state = null;
    this.erased = true;
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
  retired = new Set<string>();
  async retirePodId(podId: string) {
    this.retired.add(podId);
  }
  async forget(person: string) {
    this.keys.delete(person);
  }
}

function world() {
  const accounts = new Map<string, MemoryAccount>();
  const directory = new MemoryDirectory();
  const placed: { podId: string; placement: Placement; owner: string; withProfile: boolean }[] = [];
  const declared: { webidPodId: string; owner: string; storagePodId: string }[] = [];
  const dropped: string[] = [];
  const retired: { podId: string; deleteFiles: boolean }[] = [];
  const pods: Pods = {
    list: async (podId, owner, path) => [{ path: `${path}hello.txt`, kind: 'document', contentType: 'text/plain', size: 5, modified: `${podId} ${owner}` }],
    open: async (podId) => ({ body: new Response(podId).body!, contentType: 'text/plain', size: podId.length }),
    place: async (podId, placement, owner, withProfile) => {
      placed.push({ podId, placement, owner, withProfile });
      return 'created';
    },
    declareStorage: async (webidPodId, owner, storagePodId) => void declared.push({ webidPodId, owner, storagePodId }),
    dropStorage: async (_webidPodId, _owner, storagePodId) => void dropped.push(storagePodId),
    retire: async (podId, deleteFiles) => void retired.push({ podId, deleteFiles }),
  };
  const removedLogins: string[] = [];
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
    logins: { remove: async (person) => void removedLogins.push(person) },
    authorizations: { dropbox: authorization, other: { ...authorization, provider: 'other' } },
    ids: { random: () => `r${++n}` },
    webidOf: (podId) => `https://${podId}.pods.example/profile/card#me`,
  });
  return { service, accounts, directory, placed, declared, dropped, retired, removedLogins, bound };
}

const stateOf = (url: string) => new URL(url).searchParams.get('state')!.split('.') as [string, string];

async function connected(person = 'user_dana') {
  const w = world();
  await w.service.signup(person);
  const [key, nonce] = stateOf(await w.service.beginLink(person, 'dropbox', 'https://x/cb'));
  const state = await w.service.completeLink(person, 'dropbox', key, nonce, 'code', 'https://x/cb');
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
    await expect(service.beginLink('user_nobody', 'dropbox', 'https://x/cb')).rejects.toThrow(NotSignedUp);
  });

  it('refuses a callback it did not start, a replay, and a callback finished by someone else', async () => {
    const { service } = world();
    await service.signup('user_dana');
    await service.signup('user_eve');
    const [key, nonce] = stateOf(await service.beginLink('user_dana', 'dropbox', 'https://x/cb'));
    await expect(service.completeLink('user_dana', 'dropbox', key, 'nope', 'code', 'https://x/cb')).rejects.toThrow(LinkExpired);
    await expect(service.completeLink('user_eve', 'dropbox', key, nonce, 'code', 'https://x/cb')).rejects.toThrow(LinkExpired);
    await service.completeLink('user_dana', 'dropbox', key, nonce, 'code', 'https://x/cb');
    await expect(service.completeLink('user_dana', 'dropbox', key, nonce, 'code', 'https://x/cb')).rejects.toThrow(LinkExpired);
  });

  it('connects only the providers it offers, each through its own callback', async () => {
    const { service } = world();
    await service.signup('user_dana');
    await expect(service.beginLink('user_dana', 'onedrive', 'https://x/cb')).rejects.toThrow(NotFound);
    const [key, nonce] = stateOf(await service.beginLink('user_dana', 'dropbox', 'https://x/cb'));
    await expect(service.completeLink('user_dana', 'other', key, nonce, 'code', 'https://x/cb')).rejects.toThrow(LinkExpired);
  });

  it('adds a pod to the storage it is told, or to storage connected for it', async () => {
    const { service, placed, declared, state } = await connected();
    const first = state.links[0]!.linkId;
    const [key, nonce] = stateOf(await service.beginLink('user_dana', 'other', 'https://x/cb', true));
    const two = await service.completeLink('user_dana', 'other', key, nonce, 'code', 'https://x/cb');
    const second = two.links[1]!.linkId;
    expect(two.pods.map((p) => p.linkId)).toEqual([first, second]);
    const three = await service.addPod('user_dana', first);
    expect(three.pods.map((p) => p.linkId)).toEqual([first, second, first]);
    expect(placed.map((p) => p.placement.provider)).toEqual(['dropbox', 'other', 'dropbox']);
    expect(declared).toHaveLength(2);
    await expect(service.addPod('user_dana', 'not-a-link')).rejects.toThrow(NotFound);
  });

  it('does not place a pod twice when a second link is connected', async () => {
    const { service, placed } = await connected();
    const [key, nonce] = stateOf(await service.beginLink('user_dana', 'dropbox', 'https://x/cb'));
    await service.completeLink('user_dana', 'dropbox', key, nonce, 'code', 'https://x/cb');
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

describe('deleting', () => {
  async function withTwoPods() {
    const w = await connected();
    const state = await w.service.addPod('user_dana');
    return { ...w, state, second: state.pods[1]!.podId };
  }

  it('deletes a pod keeping its files: out of the profile, retired, its id never reused', async () => {
    const { service, second, dropped, retired, directory } = await withTwoPods();
    expect(await service.deletePod('user_dana', second, false)).toEqual({ done: true });
    expect(dropped).toEqual([second]);
    expect(retired).toEqual([{ podId: second, deleteFiles: false }]);
    expect(directory.retired.has(second)).toBe(true);
    expect((await service.mine('user_dana'))!.pods.map((p) => p.podId)).toEqual(['pod1xxxx']);
  });

  it('deletes files only after the exact sentence; a wrong one asks again under a new token', async () => {
    const { service, second, retired } = await withTwoPods();
    const step = await service.deletePod('user_dana', second, true);
    if (!('confirm' in step)) throw new Error('expected a confirmation step');
    expect(step.confirm.sentence).toBe('yes, delete my data in Dropbox');
    const wrong = await service.confirmDeletion('user_dana', step.confirm.token, 'yes, delete my data in dropbox');
    if (!('retry' in wrong)) throw new Error('expected another try');
    expect(wrong.retry.sentence).toBe(step.confirm.sentence);
    expect(retired).toEqual([]);
    await expect(service.confirmDeletion('user_dana', step.confirm.token, step.confirm.sentence)).rejects.toThrow(NotConfirmed);
    expect(await service.confirmDeletion('user_dana', wrong.retry.token, wrong.retry.sentence)).toEqual({ deleted: 'pod' });
    expect(retired).toEqual([{ podId: second, deleteFiles: true }]);
  });

  it('will not confirm someone else\'s deletion', async () => {
    const { service, second } = await withTwoPods();
    await service.signup('user_eve');
    const step = await service.deletePod('user_dana', second, true);
    if (!('confirm' in step)) throw new Error('expected a confirmation step');
    await expect(service.confirmDeletion('user_eve', step.confirm.token, step.confirm.sentence)).rejects.toThrow(NotConfirmed);
  });

  it('keeps the WebID pod, and refuses pods that are not yours', async () => {
    const { service, state } = await withTwoPods();
    await expect(service.deletePod('user_dana', state.pods[0]!.podId, false)).rejects.toThrow(HoldsWebid);
    await expect(service.deletePod('user_dana', 'nopenope', false)).rejects.toThrow(NotFound);
  });

  it('deletes the account: every pod retired, grants given up, the login removed', async () => {
    const { service, state, retired, directory, accounts, removedLogins } = await withTwoPods();
    expect(await service.deleteAccount('user_dana', false)).toEqual({ done: true });
    expect(retired.map((r) => r.podId).sort()).toEqual(state.pods.map((p) => p.podId).sort());
    expect(retired.every((r) => !r.deleteFiles)).toBe(true);
    expect([...directory.retired].sort()).toEqual(state.pods.map((p) => p.podId).sort());
    expect(accounts.get(state.key)!.erased).toBe(true);
    expect(accounts.get(state.key)!.revokedLinks).toEqual([state.links[0]!.linkId]);
    expect(removedLogins).toEqual(['user_dana']);
    expect(directory.keys.has('user_dana')).toBe(false);
  });

  it('asks for the sentence before deleting the account with its files', async () => {
    const { service, retired } = await withTwoPods();
    const step = await service.deleteAccount('user_dana', true);
    if (!('confirm' in step)) throw new Error('expected a confirmation step');
    expect(retired).toEqual([]);
    expect(await service.confirmDeletion('user_dana', step.confirm.token, step.confirm.sentence)).toEqual({ deleted: 'account' });
    expect(retired.every((r) => r.deleteFiles)).toBe(true);
  });
});

describe('disconnecting storage', () => {
  it('is refused while pods live there, naming them', async () => {
    const { service, state } = await connected();
    const linkId = state.links[0]!.linkId;
    const refused = await service.disconnect('user_dana', linkId).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(StorageInUse);
    expect((refused as StorageInUse).podIds).toEqual(['pod1xxxx']);
  });

  it('gives up a link no pod uses', async () => {
    const { service, accounts, state } = await connected();
    const [key, nonce] = stateOf(await service.beginLink('user_dana', 'dropbox', 'https://x/cb'));
    const two = await service.completeLink('user_dana', 'dropbox', key, nonce, 'code', 'https://x/cb');
    const spare = two.links[1]!.linkId;
    const after = await service.disconnect('user_dana', spare);
    expect(after.links.map((l) => l.linkId)).toEqual([state.links[0]!.linkId]);
    expect(accounts.get(state.key)!.revokedLinks).toEqual([spare]);
  });
});

describe('browsing files', () => {
  it('lists and opens files in the person\'s own placed pods, as their WebID', async () => {
    const { service, state } = await connected();
    expect(await service.files('user_dana', 'pod1xxxx', '/notes/')).toEqual([
      { path: '/notes/hello.txt', kind: 'document', contentType: 'text/plain', size: 5, modified: `pod1xxxx ${state.webid}` },
    ]);
    expect(await new Response((await service.file('user_dana', 'pod1xxxx', '/notes/hello.txt')).body).text()).toBe('pod1xxxx');
  });

  it("refuses someone else's pod and a pod still waiting for storage", async () => {
    const { service } = await connected();
    await service.signup('user_eve');
    await expect(service.files('user_eve', 'pod1xxxx', '/')).rejects.toThrow(NotFound);
    await expect(service.files('user_eve', 'pod2xxxx', '/')).rejects.toThrow(NoStorageYet);
  });
});
