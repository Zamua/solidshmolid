// Households: who manages whom, and the access rules that encode it.

import { ACL, FOAF } from '../shared/vocab.js';

export type Role = 'manager' | 'member';

export interface Member {
  clerkUserId: string;
  role: Role;
  webid: string;
  handle: string;
}

export class HouseholdRuleBroken extends Error {}

/** Refuses a membership change that would leave members without a manager. */
export function checkManagers(members: Member[]): void {
  if (members.length > 0 && !members.some((m) => m.role === 'manager')) {
    throw new HouseholdRuleBroken('a household needs at least one manager');
  }
}

const PREFIXES = `@prefix acl: <${ACL('')}>.\n@prefix foaf: <${FOAF('')}>.\n`;

/** The root ACL of a pod: its owner in full, and each manager with full
 * access to everything in it (spec 002, FR-012). */
export function rootAcl(ownerWebid: string, managerWebids: string[]): string {
  const managers = managerWebids.filter((m) => m !== ownerWebid);
  let out = `${PREFIXES}
<#owner> a acl:Authorization;
  acl:agent <${ownerWebid}>;
  acl:accessTo <./>;
  acl:default <./>;
  acl:mode acl:Read, acl:Write, acl:Control.
`;
  if (managers.length > 0) {
    out += `
<#managers> a acl:Authorization;
  ${managers.map((m) => `acl:agent <${m}>`).join(';\n  ')};
  acl:accessTo <./>;
  acl:default <./>;
  acl:mode acl:Read, acl:Write, acl:Control.
`;
  }
  return out;
}

/** The household group document: a vcard:Group listing every member's WebID. */
export function familyGroup(webids: string[]): string {
  const members = [...new Set(webids)].sort();
  return `@prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
<#members> a vcard:Group${members.length ? `;\n  vcard:hasMember ${members.map((w) => `<${w}>`).join(', ')}` : ''}.
`;
}

/** An ACL for a folder shared read-only with the household group, keeping
 * the folder's controllers. */
export function familyShareAcl(controllerWebids: string[], groupUrl: string): string {
  return `${PREFIXES}
<#controllers> a acl:Authorization;
  ${controllerWebids.map((c) => `acl:agent <${c}>`).join(';\n  ')};
  acl:accessTo <./>;
  acl:default <./>;
  acl:mode acl:Read, acl:Write, acl:Control.

<#family> a acl:Authorization;
  acl:agentGroup <${groupUrl}>;
  acl:accessTo <./>;
  acl:default <./>;
  acl:mode acl:Read.
`;
}
