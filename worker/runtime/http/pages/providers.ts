// How each storage provider appears on the account site.

import { providerDisplayName } from '../../../domain/accounts/deletion.js';
import type { IconName } from './icons.js';

export interface ProviderLook {
  name: string;
  /** As in "your …": "Your Dropbox". */
  yours: string;
  /** Where the pods' folders sit there. */
  where: string;
  icon: IconName;
  /** The provider's brand color for its logo, if it has one. */
  color: string | null;
}

const LOOKS: Record<string, ProviderLook> = {
  dropbox: { name: 'Dropbox', yours: 'Your Dropbox', where: 'A folder called Apps/solidshmolid', icon: 'dropboxLogo', color: '#0061fe' },
  'google-drive': { name: 'Google Drive', yours: 'Your Google Drive', where: 'A folder called solidshmolid in My Drive', icon: 'googleDriveLogo', color: '#1a73e8' },
  dev: { name: 'Development storage', yours: 'Development storage', where: 'Kept on this dev server only', icon: 'folderSimpleLock', color: null },
};

export function lookOf(provider: string): ProviderLook {
  return LOOKS[provider] ?? { name: providerDisplayName(provider), yours: providerDisplayName(provider), where: '', icon: 'folderSimpleLock', color: null };
}

/** "your Dropbox or Google Drive", for the providers people may connect. */
export function storagePhrase(providers: string[]): string {
  const names = providers.filter((p) => p !== 'dev').map(providerDisplayName);
  return names.length ? `your ${names.join(' or ')}` : 'your own storage';
}
