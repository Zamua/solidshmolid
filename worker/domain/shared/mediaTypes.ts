// Media types as the HTTP layer and RDF code compare them.

/** A media type without parameters, lowercased. */
export function bareType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
}
