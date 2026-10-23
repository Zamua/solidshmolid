// The WebID profile document: what a new pod starts with, what it says, and
// the patches that change it.

import type { Quad } from 'n3';
import { FOAF, PIM, SOLID } from '../shared/vocab.js';

/** Turtle for `/profile/card`. `issuer` is the Solid-OIDC issuer trusted to
 * authenticate this WebID; null until the pod's owner has one. */
export function profileDocument(storage: string, issuer: string | null): string {
  const lines = [
    '@prefix foaf: <http://xmlns.com/foaf/0.1/>.',
    '@prefix solid: <http://www.w3.org/ns/solid/terms#>.',
    '@prefix pim: <http://www.w3.org/ns/pim/space#>.',
    '',
    '<> a foaf:PersonalProfileDocument;',
    '  foaf:maker <#me>;',
    '  foaf:primaryTopic <#me>.',
    '',
    '<#me> a foaf:Person;',
    ...(issuer ? [`  solid:oidcIssuer <${issuer}>;`] : []),
    `  pim:storage <${storage}>.`,
    '',
  ];
  return lines.join('\n');
}

/** An N3 Patch for `/profile/card` listing one more storage of `<#me>`, so
 * apps that read the profile find every pod the person has. */
export function addStoragePatch(storage: string): string {
  return `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix pim: <http://www.w3.org/ns/pim/space#>.
_:add a solid:InsertDeletePatch;
  solid:inserts { <#me> pim:storage <${storage}>. }.
`;
}

/** The reverse of `addStoragePatch`. */
export function removeStoragePatch(storage: string): string {
  return `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix pim: <http://www.w3.org/ns/pim/space#>.
_:remove a solid:InsertDeletePatch;
  solid:deletes { <#me> pim:storage <${storage}>. }.
`;
}

export interface ProfileSummary {
  name: string | null;
  storages: string[];
  issuers: string[];
}

/** What a profile says about `webid`. */
export function summarizeProfile(quads: Quad[], webid: string): ProfileSummary {
  const about = (predicate: string) => quads.filter((q) => q.subject.value === webid && q.predicate.value === predicate).map((q) => q.object.value);
  return { name: about(FOAF('name'))[0] ?? null, storages: about(PIM('storage')), issuers: about(SOLID('oidcIssuer')) };
}

/** An N3 Patch for `/profile/card` setting `<#me>`'s name. */
export function renamePatch(current: string | null, next: string): string {
  const literal = (s: string) => JSON.stringify(s);
  const deletes = current === null ? '' : `\n  solid:deletes { <#me> foaf:name ${literal(current)}. };`;
  return `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
_:rename a solid:InsertDeletePatch;${deletes}
  solid:inserts { <#me> foaf:name ${literal(next)}. }.
`;
}
