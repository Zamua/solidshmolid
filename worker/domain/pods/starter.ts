// The access rules a new pod starts with.

import { ACL, FOAF } from '../shared/vocab.js';

const PREFIXES = `@prefix acl: <${ACL('')}>.\n@prefix foaf: <${FOAF('')}>.\n`;

/** The root ACL: the owner in full, plus any other controllers (a household's
 * managers) with full access to everything in the pod. */
export function podRootAcl(owner: string, controllers: string[] = []): string {
  const others = [...new Set(controllers)].filter((c) => c !== owner);
  let out = `${PREFIXES}
<#owner> a acl:Authorization;
  acl:agent <${owner}>;
  acl:accessTo <./>;
  acl:default <./>;
  acl:mode acl:Read, acl:Write, acl:Control.
`;
  if (others.length > 0) {
    out += `
<#managers> a acl:Authorization;
  ${others.map((m) => `acl:agent <${m}>`).join(';\n  ')};
  acl:accessTo <./>;
  acl:default <./>;
  acl:mode acl:Read, acl:Write, acl:Control.
`;
  }
  return out;
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
