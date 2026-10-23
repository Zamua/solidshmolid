// What our own pages run beyond Clerk: the account menu closing like a menu,
// and copy buttons, shown only where the clipboard is there to use. Served
// from our origin, so pages carry no inline script.

export const PAGE_SCRIPT_PATH = '/assets/page.js';

export const PAGE_SCRIPT = `(() => {
  const menu = document.querySelector('.account-menu');
  if (menu) {
    document.addEventListener('click', (e) => {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu.open) {
        menu.open = false;
        menu.querySelector('summary').focus();
      }
    });
  }
  if (!navigator.clipboard) return;
  for (const button of document.querySelectorAll('[data-copy]')) {
    const label = button.querySelector('[data-label]');
    button.hidden = false;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
      } catch {
        return;
      }
      label.textContent = 'Copied';
      button.classList.add('copied');
      setTimeout(() => {
        label.textContent = 'Copy';
        button.classList.remove('copied');
      }, 1600);
    });
  }
})();
`;
