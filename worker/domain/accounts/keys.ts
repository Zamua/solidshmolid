// Account keys, and the OAuth `state` a storage consent carries back.

/** The shape of the ids `randomHex` draws, which account keys are. */
const ACCOUNT_KEY = /^[0-9a-f]{32}$/u;

export function isAccountKey(value: string): boolean {
  return ACCOUNT_KEY.test(value);
}

/** Whose account started a storage consent, and which attempt it was. */
export function linkState(accountKey: string, nonce: string): string {
  return `${accountKey}.${nonce}`;
}

export function parseLinkState(state: string | null): { accountKey: string; nonce: string } | null {
  const [accountKey, nonce, ...rest] = (state ?? '').split('.');
  return accountKey && nonce && rest.length === 0 ? { accountKey, nonce } : null;
}
