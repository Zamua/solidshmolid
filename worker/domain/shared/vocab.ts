// The vocabularies a pod speaks.

const ns = (base: string) => (local: string) => `${base}${local}`;

export const RDF = ns('http://www.w3.org/1999/02/22-rdf-syntax-ns#');
export const XSD = ns('http://www.w3.org/2001/XMLSchema#');
export const LDP = ns('http://www.w3.org/ns/ldp#');
export const ACL = ns('http://www.w3.org/ns/auth/acl#');
export const FOAF = ns('http://xmlns.com/foaf/0.1/');
export const SOLID = ns('http://www.w3.org/ns/solid/terms#');
export const PIM = ns('http://www.w3.org/ns/pim/space#');
export const DCT = ns('http://purl.org/dc/terms/');
export const MA = ns('http://www.w3.org/ns/ma-ont#');

export const PREFIXES: Record<string, string> = {
  rdf: RDF(''),
  xsd: XSD(''),
  ldp: LDP(''),
  acl: ACL(''),
  foaf: FOAF(''),
  solid: SOLID(''),
  pim: PIM(''),
  dc: DCT(''),
};
