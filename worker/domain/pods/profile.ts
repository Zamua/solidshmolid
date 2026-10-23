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
