// Web Access Control: which modes an ACL document grants an agent.
//
// Pure evaluation over parsed authorizations. Finding WHICH ACL document
// applies (the resource's own, or the nearest ancestor's defaults) needs the
// index and lives in the pod service.

import { Store, DataFactory, type Quad } from 'n3';
import { ACL, FOAF, RDF } from '../shared/vocab.js';

const { namedNode } = DataFactory;

export type Mode = 'read' | 'append' | 'write' | 'control';
export const MODES: readonly Mode[] = ['read', 'append', 'write', 'control'];

export interface Authorization {
  accessTo: string[];
  defaults: string[];
  agents: string[];
  agentClasses: string[];
  modes: Mode[];
}

const MODE_IRIS: Record<string, Mode> = {
  [ACL('Read')]: 'read',
  [ACL('Append')]: 'append',
  [ACL('Write')]: 'write',
  [ACL('Control')]: 'control',
};

/** The authorizations in an ACL document. Resource IRIs are absolute, so the
 * quads must have been parsed against the ACL document's own URL. */
export function authorizationsOf(quads: Quad[]): Authorization[] {
  const store = new Store(quads);
  const objects = (s: Quad['subject'], p: string) =>
    store.getObjects(s, namedNode(p), null).map((o) => o.value);
  return store.getSubjects(namedNode(RDF('type')), namedNode(ACL('Authorization')), null).map((s) => ({
    accessTo: objects(s, ACL('accessTo')),
    defaults: objects(s, ACL('default')),
    agents: objects(s, ACL('agent')),
    agentClasses: objects(s, ACL('agentClass')),
    modes: objects(s, ACL('mode')).flatMap((m) => (MODE_IRIS[m] ? [MODE_IRIS[m]!] : [])),
  }));
}

export interface Target {
  /** Absolute URL of the resource being accessed. */
  url: string;
  /** Set when the ACL in force belongs to an ancestor: its container URL.
   * Only `acl:default` authorizations for that container then apply. */
  inheritedFrom: string | null;
}

function appliesTo(auth: Authorization, target: Target): boolean {
  return target.inheritedFrom === null
    ? auth.accessTo.includes(target.url)
    : auth.defaults.includes(target.inheritedFrom);
}

function matchesAgent(auth: Authorization, webid: string | null): boolean {
  if (auth.agentClasses.includes(FOAF('Agent'))) return true;
  if (webid === null) return false;
  return auth.agentClasses.includes(ACL('AuthenticatedAgent')) || auth.agents.includes(webid);
}

/** The modes granted to `webid` (null: an unauthenticated request). Write
 * implies Append. */
export function grantedModes(auths: Authorization[], target: Target, webid: string | null): Set<Mode> {
  const out = new Set<Mode>();
  for (const auth of auths) {
    if (!appliesTo(auth, target) || !matchesAgent(auth, webid)) continue;
    for (const m of auth.modes) out.add(m);
  }
  if (out.has('write')) out.add('append');
  return out;
}

/** The `WAC-Allow` header value. */
export function wacAllow(user: Set<Mode>, pub: Set<Mode>): string {
  const list = (s: Set<Mode>) => MODES.filter((m) => s.has(m)).join(' ');
  return `user="${list(user)}",public="${list(pub)}"`;
}
