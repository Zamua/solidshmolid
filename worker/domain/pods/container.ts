// The RDF description of a container, built from the index.

import { DataFactory, type Quad } from 'n3';
import { DCT, LDP, PIM, RDF, XSD } from '../shared/vocab.js';

const { namedNode, literal, quad } = DataFactory;

export interface Member {
  url: string;
}

export function containerDescription(url: string, members: Member[], modified: string, isStorage: boolean): Quad[] {
  const self = namedNode(url);
  const a = namedNode(RDF('type'));
  const out = [
    quad(self, a, namedNode(LDP('Container'))),
    quad(self, a, namedNode(LDP('BasicContainer'))),
    quad(self, a, namedNode(LDP('Resource'))),
    quad(self, namedNode(DCT('modified')), literal(modified, namedNode(XSD('dateTime')))),
  ];
  if (isStorage) out.push(quad(self, a, namedNode(PIM('Storage'))));
  for (const m of members) out.push(quad(self, namedNode(LDP('contains')), namedNode(m.url)));
  return out;
}
