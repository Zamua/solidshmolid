// The one script our pages run: it starts Clerk (which keeps the session
// fresh while a page is open), mounts sign-in or signs out where a page asks,
// and drives our own sign-up form (email code or Google). Served from our
// origin, so pages carry no inline script.

export const CLERK_BOOT_PATH = '/assets/clerk-boot.js';

export const CLERK_BOOT = `(() => {
  // Clerk's sign-in dressed as our own cards, fields and buttons; the page
  // gives the heading, so Clerk's is hidden.
  const display = "'Fredoka', system-ui, sans-serif";
  const button = { minHeight: '56px', borderRadius: '18px', fontFamily: display, fontSize: '18px', fontWeight: 600, textTransform: 'none' };
  const appearance = {
    variables: {
      colorPrimary: '#3d6fe0',
      colorText: '#1f2d4d',
      colorTextSecondary: '#506080',
      colorInputBackground: '#f3f8ff',
      fontFamily: "'Atkinson Hyperlegible', system-ui, sans-serif",
      fontSize: '17px',
      borderRadius: '16px',
    },
    elements: {
      rootBox: { width: '100%' },
      cardBox: { width: '100%', maxWidth: 'none', borderRadius: '26px', border: '0', boxShadow: '0 1px 0 #dbe7fa, 0 14px 30px -18px rgba(42,82,184,.35)' },
      card: { padding: '20px', boxShadow: 'none', border: '0', borderRadius: '26px' },
      header: { display: 'none' },
      socialButtonsBlockButton: { ...button, color: '#1f2d4d', border: '0', boxShadow: '0 0 0 2px #dbe7fa' },
      socialButtonsBlockButtonText: { fontFamily: display, fontSize: '18px', fontWeight: 600, color: '#1f2d4d' },
      formFieldLabel: { fontSize: '15px', fontWeight: 700 },
      formFieldInput: { minHeight: '58px', padding: '0 16px', fontSize: '18px', borderRadius: '16px', border: '0', backgroundColor: '#f3f8ff', boxShadow: '0 0 0 2px #dbe7fa' },
      formButtonPrimary: { ...button, background: '#3d6fe0', boxShadow: '0 10px 20px -12px #3d6fe0', '&::after': { display: 'none' } },
      buttonArrowIcon: { display: 'none' },
      footer: { background: 'transparent' },
      footerActionText: { fontSize: '15px' },
      footerActionLink: { fontSize: '15px', fontWeight: 700 },
    },
  };
  const localization = {
    formFieldLabel__emailAddress_username: 'Email',
    formFieldInputPlaceholder__emailAddress_username: '',
    signIn: { start: { actionText: 'New here?', actionLink: 'Create your account' } },
  };

  // Clerk's errors carry a sentence for people; anything else gets a plain one.
  const messageOf = (e) => (e && e.errors && e.errors[0] && (e.errors[0].longMessage || e.errors[0].message)) || 'Something went wrong. Try again.';

  function signUpForm(Clerk, root, back) {
    const emailForm = root.querySelector('[data-email-form]');
    const codeForm = root.querySelector('[data-code-form]');
    const problem = root.querySelector('[data-problem]');
    const say = (text) => {
      problem.textContent = text || '';
      problem.hidden = !text;
    };
    const busy = (form, on) => form.querySelectorAll('button').forEach((b) => (b.disabled = on));

    root.querySelector('[data-google]').addEventListener('click', async () => {
      say('');
      try {
        await Clerk.client.signUp.authenticateWithRedirect({
          strategy: 'oauth_google',
          redirectUrl: '/sso-callback?return=' + encodeURIComponent(back),
          redirectUrlComplete: back,
        });
      } catch (e) {
        say(messageOf(e));
      }
    });

    emailForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      say('');
      busy(emailForm, true);
      const emailAddress = emailForm.querySelector('[name=email]').value.trim();
      try {
        await Clerk.client.signUp.create({ emailAddress });
        await Clerk.client.signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
        root.querySelector('[data-email-shown]').textContent = emailAddress;
        emailForm.hidden = true;
        codeForm.hidden = false;
        codeForm.querySelector('[name=code]').focus();
      } catch (e) {
        say(messageOf(e));
      } finally {
        busy(emailForm, false);
      }
    });

    codeForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      say('');
      busy(codeForm, true);
      try {
        const code = codeForm.querySelector('[name=code]').value.trim();
        let result = await Clerk.client.signUp.attemptEmailAddressVerification({ code });
        // Clerk's bot protection can ask for one more check; its own UI runs it.
        if (result.missingFields.includes('protect_check') && Clerk.__internal_resolvePendingProtectCheck) {
          await Clerk.__internal_resolvePendingProtectCheck('signUp');
          result = await Clerk.client.signUp.reload();
        }
        if (result.status !== 'complete') throw new Error('incomplete');
        await Clerk.setActive({ session: result.createdSessionId });
        location.replace(back);
      } catch (e) {
        say(messageOf(e));
        busy(codeForm, false);
      }
    });

    codeForm.querySelector('[data-back]').addEventListener('click', () => {
      say('');
      codeForm.hidden = true;
      emailForm.hidden = false;
    });
  }

  window.addEventListener('load', async () => {
    const Clerk = window.Clerk;
    if (!Clerk) return;
    await Clerk.load({ appearance, localization, ui: { ClerkUI: window.__internal_ClerkUICtor } });
    const mount = document.querySelector('[data-clerk-mount]');
    if (!mount) return;
    const back = mount.dataset.return || '/';
    switch (mount.dataset.clerkMount) {
      case 'sign-in':
        if (Clerk.user) return location.replace(back);
        return Clerk.mountSignIn(mount, { forceRedirectUrl: back, signUpUrl: '/sign-up?return=' + encodeURIComponent(back), signUpForceRedirectUrl: back });
      case 'sign-up':
        if (Clerk.user) return location.replace(back);
        return signUpForm(Clerk, mount, back);
      case 'sso-callback':
        return Clerk.handleRedirectCallback({ signInForceRedirectUrl: back, signUpForceRedirectUrl: back, signInFallbackRedirectUrl: back, signUpFallbackRedirectUrl: back });
      case 'sign-out':
        return Clerk.signOut({ redirectUrl: '/' });
    }
  });
})();
`;
