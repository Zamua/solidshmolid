// The one page for every refusal or failure a person can land on: what
// happened in a sentence, any technical detail in small print, and the way on.

import { icon } from './icons.js';
import { escapeHtml, page } from './shell.js';

export interface WayOn {
  href: string;
  label: string;
}

export interface ProblemOptions {
  way?: WayOn;
  /** Protocol text or an error code, for whoever reports the problem. */
  detail?: string;
  /** The account site's front page, from pages on other hosts. */
  home?: string;
}

export function problemPage(title: string, sentence: string, status: number, options: ProblemOptions = {}): Response {
  const home = options.home ?? '/';
  const way = options.way ?? { href: home, label: 'Go to your pods' };
  return page(
    title,
    `<div class="icon-tile problem-icon">${icon('warningCircle')}</div>
<h1>${escapeHtml(title)}</h1>
<p class="lede">${escapeHtml(sentence)}</p>
${options.detail ? `<p class="small" style="margin-top:12px">${escapeHtml(options.detail)}</p>` : ''}
<div class="dock"><div><a class="btn primary" href="${escapeHtml(way.href)}">${escapeHtml(way.label)}</a></div></div>`,
    status,
    home,
  );
}

/** A sentence from a lowercase error message ('that pod is gone' → 'That pod is gone.'). */
export function sentenceOf(message: string): string {
  const s = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/u.test(s) ? s : `${s}.`;
}
