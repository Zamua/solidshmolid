// Who is signed in at a browser. Deployments will ask Clerk; the dev config
// trusts a `dev_person` cookie that /dev/sign-in sets.

export interface Sessions {
  /** The signed-in person's id, or null. */
  personOf(request: Request): Promise<string | null>;
}

export const DEV_PERSON_COOKIE = 'dev_person';

export const devSessions: Sessions = {
  async personOf(request) {
    const cookie = request.headers.get('Cookie') ?? '';
    const m = new RegExp(`(?:^|;\\s*)${DEV_PERSON_COOKIE}=([\\w-]{1,64})`, 'u').exec(cookie);
    return m ? m[1]! : null;
  },
};

/** Until Clerk is wired in, deployments have nobody signed in. */
export const noSessions: Sessions = { personOf: async () => null };
