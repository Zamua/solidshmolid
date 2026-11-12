import { describe, expect, it } from 'vitest';
import type { AccountState } from '../app/accounts/ports.js';
import type { Hosts } from '../runtime/hosts.js';
import { connectionsPage, podsPage } from '../runtime/http/pages/home.js';

const HOSTS = {} as Hosts;

function account(grantLost: boolean): AccountState {
  return {
    key: 'k1',
    webid: 'https://k3x9fqm7.pods.example/profile/card#me',
    pods: [{ podId: 'k3x9fqm7', linkId: 'l1', folder: 'k3x9fqm7' }],
    links: [
      { linkId: 'l1', provider: 'dropbox', account: 'dbid:1', grantLost },
      { linkId: 'l2', provider: 'google-drive', account: 'perm1', grantLost: false },
    ],
  };
}

describe('storage whose grant stopped working', () => {
  it('is offered to connect again on the Connections page, where it holds pods or not', async () => {
    const html = await connectionsPage(account(true), ['dropbox', 'google-drive']).text();
    expect(html).toContain('We lost access');
    expect(html).toContain('action="/api/storage/dropbox/start"');
    expect(html).toContain('its pod has stopped');
    // Healthy storage with no pods keeps its Disconnect.
    expect(html).toContain('action="/api/storage/l2/disconnect"');
  });

  it('shows its pods as stopped, with the way to the repair, in place of a file browser that would fail', async () => {
    const html = await podsPage(account(true), [], HOSTS, ['dropbox']).text();
    expect(html).toContain('href="/connections"');
    expect(html).not.toContain('/pods/k3x9fqm7/files');
  });

  it('says nothing of the kind while the grant works', async () => {
    const connections = await connectionsPage(account(false), ['dropbox', 'google-drive']).text();
    expect(connections).not.toContain('We lost access');
    expect(connections).not.toContain('/start"');
    expect(await podsPage(account(false), [], HOSTS, ['dropbox']).text()).toContain('/pods/k3x9fqm7/files');
  });
});
