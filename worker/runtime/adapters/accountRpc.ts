// Accounts over Durable Object RPC: the directory maps a person to an account
// key, and each account key names one AccountObject.

import type { AccountStore, Accounts } from '../../app/identity/ports.js';
import type { Env } from '../env.js';
import type { AccountObject } from '../objects/accountObject.js';

const ACCOUNT_KEY = /^[0-9a-f]{32}$/u;

export class RpcAccounts implements Accounts {
  constructor(private readonly env: Env) {}

  async forPerson(personId: string): Promise<AccountStore> {
    const key = await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('directory')).accountKeyFor(personId);
    const stub = this.stub(key);
    await stub.ensure(key);
    return accountStore(stub, key);
  }

  async byKey(key: string): Promise<AccountStore | null> {
    return ACCOUNT_KEY.test(key) ? accountStore(this.stub(key), key) : null;
  }

  private stub(key: string): DurableObjectStub<AccountObject> {
    return this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(key));
  }
}

function accountStore(stub: DurableObjectStub<AccountObject>, key: string): AccountStore {
  return {
    key,
    webid: () => stub.webid(),
    hasApproval: (clientId, webid) => stub.hasApproval(clientId, webid),
    approve: (clientId, name, webid) => stub.approve(clientId, name, webid),
    savePending: (id, request, client, expires) => stub.savePending(id, request, client, expires),
    takePending: (id, now) => stub.takePending(id, now),
    saveCode: (hash, grant) => stub.saveCode(hash, grant),
    takeCode: (hash) => stub.takeCode(hash),
    saveFamily: (family) => stub.saveFamily(family),
    family: (id) => stub.family(id),
    rotateFamily: (id, hash, expires) => stub.rotateFamily(id, hash, expires),
    revokeFamily: (id) => stub.revokeFamily(id),
    revokeFromCode: (hash) => stub.revokeFromCode(hash),
  };
}
