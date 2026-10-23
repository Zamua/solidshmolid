// The WebID profile document a new pod starts with.

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
