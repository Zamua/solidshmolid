import { describe, expect, it } from 'vitest';
import { parseRdf } from '../domain/rdf.js';
import { authorizationsOf, grantedModes, wacAllow } from '../domain/wac.js';

const POD = 'https://alice.example';
const ALICE = `${POD}/profile/card#me`;
const BOB = 'https://bob.example/profile/card#me';

const acl = (turtle: string, at = `${POD}/.acl`) =>
  authorizationsOf(
    parseRdf(`@prefix acl: <http://www.w3.org/ns/auth/acl#>. @prefix foaf: <http://xmlns.com/foaf/0.1/>.\n${turtle}`, 'text/turtle', at),
  );

const ROOT = acl(`
  <#owner> a acl:Authorization; acl:agent <${ALICE}>;
    acl:accessTo <./>; acl:default <./>;
    acl:mode acl:Read, acl:Write, acl:Control.
  <#public> a acl:Authorization; acl:agentClass foaf:Agent;
    acl:accessTo <./>; acl:mode acl:Read.
  <#members> a acl:Authorization; acl:agentClass acl:AuthenticatedAgent;
    acl:default <./>; acl:mode acl:Append.
`);

const set = (...m: string[]) => new Set(m);

describe('grantedModes', () => {
  it('grants the owner everything on the container itself', () => {
    expect(grantedModes(ROOT, { url: `${POD}/`, inheritedFrom: null }, ALICE)).toEqual(
      set('read', 'write', 'control', 'append'),
    );
  });

  it('applies accessTo only to the container and default only to descendants', () => {
    const own = { url: `${POD}/`, inheritedFrom: null };
    const child = { url: `${POD}/notes/a.ttl`, inheritedFrom: `${POD}/` };
    expect(grantedModes(ROOT, own, null)).toEqual(set('read'));
    expect(grantedModes(ROOT, child, null)).toEqual(set());
    expect(grantedModes(ROOT, child, BOB)).toEqual(set('append'));
    expect(grantedModes(ROOT, own, BOB)).toEqual(set('read'));
  });

  it('ignores statements that are not typed acl:Authorization', () => {
    const untyped = acl(`<#x> acl:agentClass foaf:Agent; acl:accessTo <./>; acl:mode acl:Write.`);
    expect(grantedModes(untyped, { url: `${POD}/`, inheritedFrom: null }, null)).toEqual(set());
  });

  it('resolves relative IRIs against the ACL document', () => {
    const own = acl(`<#r> a acl:Authorization; acl:agent <${BOB}>; acl:accessTo <a.ttl>; acl:mode acl:Read.`, `${POD}/notes/a.ttl.acl`);
    expect(grantedModes(own, { url: `${POD}/notes/a.ttl`, inheritedFrom: null }, BOB)).toEqual(set('read'));
  });
});

describe('wacAllow', () => {
  it('lists modes in a stable order', () => {
    expect(wacAllow(set('write', 'read', 'append'), set())).toBe('user="read append write",public=""');
  });
});
