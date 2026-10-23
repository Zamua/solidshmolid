import { describe, expect, it } from 'vitest';
import { HouseholdRuleBroken, type Member, checkManagers, familyGroup, rootAcl } from '../domain/household.js';
import { parseRdf } from '../domain/rdf.js';
import { authorizationsOf, grantedModes } from '../domain/wac.js';

const DANA = 'https://dana.example/profile/card#me';
const SAM = 'https://sam.example/profile/card#me';
const ALEX = 'https://alex.example/profile/card#me';
const STRANGER = 'https://x.example/#me';
const POD = 'https://sam.example';

const member = (webid: string, role: Member['role']): Member => ({ clerkUserId: webid, role, webid, handle: 'h' });

describe('household rules', () => {
  it('needs a manager while anyone is in it', () => {
    expect(() => checkManagers([member(DANA, 'manager'), member(SAM, 'member')])).not.toThrow();
    expect(() => checkManagers([member(SAM, 'member')])).toThrow(HouseholdRuleBroken);
    expect(() => checkManagers([])).not.toThrow();
  });
});

describe('member pod access', () => {
  const modes = async (acl: string, webid: string, url: string, inherited: boolean) =>
    grantedModes(authorizationsOf(await parseRdf(acl, 'text/turtle', `${POD}/.acl`)), { url, inheritedFrom: inherited ? `${POD}/` : null }, webid);

  it('gives the member and every manager full access, everywhere in the pod', async () => {
    const acl = rootAcl(SAM, [DANA, ALEX]);
    for (const who of [SAM, DANA, ALEX]) {
      expect(await modes(acl, who, `${POD}/`, false)).toEqual(new Set(['read', 'write', 'append', 'control']));
      expect(await modes(acl, who, `${POD}/drawings/cat.png`, true)).toEqual(new Set(['read', 'write', 'append', 'control']));
    }
    expect(await modes(acl, STRANGER, `${POD}/`, false)).toEqual(new Set());
  });

  it('drops the managers when there are none, as after a handover', async () => {
    const acl = rootAcl(SAM, []);
    expect(await modes(acl, DANA, `${POD}/`, false)).toEqual(new Set());
    expect(acl).not.toContain('#managers');
  });
});

describe('family group document', () => {
  it('lists each member once', async () => {
    const quads = await parseRdf(familyGroup([SAM, DANA, SAM]), 'text/turtle', 'https://dana.example/household/members.ttl');
    const members = quads.filter((q) => q.predicate.value.endsWith('#hasMember')).map((q) => q.object.value);
    expect(members.sort()).toEqual([DANA, SAM].sort());
  });
});
