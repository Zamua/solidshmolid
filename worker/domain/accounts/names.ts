// The name a person goes by: what apps read from their profile.

export class InvalidName extends Error {}

const NAME_MAX = 60;

/** A name as given, with runs of whitespace collapsed; refuses an empty,
 * overlong or control-character one. */
export function personName(raw: string): string {
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (name.length === 0) throw new InvalidName('give a name');
  if ([...name].length > NAME_MAX) throw new InvalidName(`a name has at most ${NAME_MAX} characters`);
  if (/\p{Cc}/u.test(name)) throw new InvalidName('a name cannot hold control characters');
  return name;
}
