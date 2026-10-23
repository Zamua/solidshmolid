// The access rules a new pod starts with.

import { ACL, FOAF } from '../shared/vocab.js';

const PREFIXES = `@prefix acl: <${ACL('')}>.\n@prefix foaf: <${FOAF('')}>.\n`;

/** The root ACL: the owner in full, everywhere in the pod. */
export function podRootAcl(owner: string): string {
  return `${PREFIXES}
<#owner> a acl:Authorization;
  acl:agent <${owner}>;
  acl:accessTo <./>;
  acl:default <./>;
  acl:mode acl:Read, acl:Write, acl:Control.
`;
}

/** The profile document's ACL: public read, owner in full. */
export function profileAcl(owner: string): string {
  return `${PREFIXES}
<#owner> a acl:Authorization;
  acl:agent <${owner}>;
  acl:accessTo <./card>;
  acl:mode acl:Read, acl:Write, acl:Control.
<#public> a acl:Authorization;
  acl:agentClass foaf:Agent;
  acl:accessTo <./card>;
  acl:mode acl:Read.
`;
}
