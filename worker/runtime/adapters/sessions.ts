// Who is signed in at a browser, for the apex host. Deployments ask Clerk;
// the dev config also trusts a `dev_person` cookie that /dev/sign-in sets.

export interface SessionCheck {
  /** The signed-in person's id, or null. */
  person: string | null;
  /** Answer with this instead: a page load whose session must be refreshed first. */
  redirect: Response | null;
  /** Add these to the response (refreshed session cookies). */
  headers: Headers | null;
}

export interface Sessions {
  check(request: Request): Promise<SessionCheck>;
}

export const SIGNED_OUT: SessionCheck = { person: null, redirect: null, headers: null };

export const DEV_PERSON_COOKIE = 'dev_person';

export const devSessions: Sessions = {
  async check(request) {
    const cookie = request.headers.get('Cookie') ?? '';
    const m = new RegExp(`(?:^|;\\s*)${DEV_PERSON_COOKIE}=([\\w-]{1,64})`, 'u').exec(cookie);
    return m ? { person: m[1]!, redirect: null, headers: null } : SIGNED_OUT;
  },
};

export const noSessions: Sessions = { check: async () => SIGNED_OUT };

/** The first source that knows the person, or the last one's answer. */
export function firstOf(...sources: Sessions[]): Sessions {
  return {
    async check(request) {
      let last = SIGNED_OUT;
      for (const source of sources) {
        last = await source.check(request);
        if (last.person || last.redirect) return last;
      }
      return last;
    },
  };
}
