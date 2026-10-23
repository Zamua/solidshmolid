// The one script our pages run: it starts Clerk (which keeps the session
// fresh while a page is open) and mounts sign-in, sign-up or sign-out where a
// page asks for it. Served from our origin, so pages carry no inline script.

export const CLERK_BOOT_PATH = '/assets/clerk-boot.js';

export const CLERK_BOOT = `(() => {
  const appearance = {
    variables: {
      colorPrimary: '#3d6fe0',
      colorText: '#1f2d4d',
      colorTextSecondary: '#5a6b8c',
      fontFamily: "'Atkinson Hyperlegible', system-ui, sans-serif",
      borderRadius: '14px',
    },
  };
  window.addEventListener('load', async () => {
    const Clerk = window.Clerk;
    if (!Clerk) return;
    await Clerk.load({ appearance, ui: { ClerkUI: window.__internal_ClerkUICtor } });
    const mount = document.querySelector('[data-clerk-mount]');
    if (!mount) return;
    const back = mount.dataset.return || '/';
    const signUpUrl = '/sign-up?return=' + encodeURIComponent(back);
    const signInUrl = '/sign-in?return=' + encodeURIComponent(back);
    switch (mount.dataset.clerkMount) {
      case 'sign-in':
        if (Clerk.user) return location.replace(back);
        return Clerk.mountSignIn(mount, { forceRedirectUrl: back, signUpUrl, signUpForceRedirectUrl: back });
      case 'sign-up':
        if (Clerk.user) return location.replace(back);
        return Clerk.mountSignUp(mount, { forceRedirectUrl: back, signInUrl, signInForceRedirectUrl: back });
      case 'sign-out':
        return Clerk.signOut({ redirectUrl: '/' });
    }
  });
})();
`;
