import { describe, expect, it } from 'vitest';
import { applyPatch, parsePatch } from '../domain/pods/n3patch.js';
import { addStoragePatch, profileDocument } from '../domain/pods/profile.js';
import { podRootAcl, profileAcl } from '../domain/pods/starter.js';
import { authorizationsOf, grantedModes } from '../domain/pods/wac.js';
import { parseRdf } from '../domain/shared/rdf.js';

const DANA = 'https://dana.example/profile/card#me';
const STRANGER = 'https://x.example/#me';
const POD = 'https://dana.example';
const PIM_STORAGE = 'http://www.w3.org/ns/pim/space#storage';

const modes = async (acl: string, aclUrl: string, webid: string | null, url: string, inheritedFrom: string | null) =>
  grantedModes(authorizationsOf(await parseRdf(acl, 'text/turtle', aclUrl)), { url, inheritedFrom }, webid);

describe('a new pod', () => {
  it('gives its owner full access everywhere, and nobody else any', async () => {
    const acl = podRootAcl(DANA);
    expect(await modes(acl, `${POD}/.acl`, DANA, `${POD}/`, null)).toEqual(new Set(['read', 'write', 'append', 'control']));
    expect(await modes(acl, `${POD}/.acl`, DANA, `${POD}/photos/cat.png`, `${POD}/`)).toEqual(new Set(['read', 'write', 'append', 'control']));
    expect(await modes(acl, `${POD}/.acl`, STRANGER, `${POD}/`, null)).toEqual(new Set());
    expect(await modes(acl, `${POD}/.acl`, null, `${POD}/`, null)).toEqual(new Set());
  });

  it('lets anyone read the profile, and only the owner change it', async () => {
    const acl = profileAcl(DANA);
    expect(await modes(acl, `${POD}/profile/card.acl`, null, `${POD}/profile/card`, null)).toEqual(new Set(['read']));
    expect(await modes(acl, `${POD}/profile/card.acl`, DANA, `${POD}/profile/card`, null)).toEqual(new Set(['read', 'write', 'append', 'control']));
  });

  it('lists further pods in the profile as storages of the WebID', async () => {
    const card = `${POD}/profile/card`;
    const before = await parseRdf(profileDocument(`${POD}/`, 'https://issuer.example/'), 'text/turtle', card);
    const after = applyPatch(before, parsePatch(addStoragePatch('https://work.example/'), card));
    const storages = after.filter((q) => q.subject.value === DANA && q.predicate.value === PIM_STORAGE).map((q) => q.object.value);
    expect(storages.sort()).toEqual([`${POD}/`, 'https://work.example/']);
  });
});
