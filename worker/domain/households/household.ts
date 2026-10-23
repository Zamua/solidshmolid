// Households: who manages whom, and the access rules that encode it.

import { ACL, FOAF } from '../shared/vocab.js';

export type Role = 'manager' | 'member';

/** `adult`: signs in with their own identifiers. `managed`: has no email; a
 * manager created their login and sets up their devices. */
export type Kind = 'adult' | 'managed';

export interface Member {
  clerkUserId: string;
  role: Role;
  kind: Kind;
  /** What the household calls them; display only. */
  name: string;
  webid: string;
  handle: string;
}

export class HouseholdRuleBroken extends Error {}

const NAME_MAX = 40;

/** A member's name as given, trimmed; refuses an empty or overlong one. */
export function memberName(raw: string): string {
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (name.length === 0) throw new HouseholdRuleBroken('give them a name');
  if ([...name].length > NAME_MAX) throw new HouseholdRuleBroken(`a name has at most ${NAME_MAX} characters`);
  if (/\p{Cc}/u.test(name)) throw new HouseholdRuleBroken('a name cannot hold control characters');
  return name;
}

/** Refuses a membership change that would leave members without a manager. */
export function checkManagers(members: Member[]): void {
  if (members.length > 0 && !members.some((m) => m.role === 'manager')) {
    throw new HouseholdRuleBroken('a household needs at least one manager');
  }
}

const PREFIXES = `@prefix acl: <${ACL('')}>.\n@prefix foaf: <${FOAF('')}>.\n`;

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
