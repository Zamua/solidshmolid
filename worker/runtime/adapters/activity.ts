// Activity events as Workers Analytics Engine data points: the index is the
// actor, keyed-hashed so the stored value cannot be turned back into a pod id.

import type { Activity, ActivityEvent } from '../../app/shared/activity.js';

export const ACTIVITY_APP = 'solidshmolid';
const NO_ACTOR = '-';
const HASH_HEX_CHARS = 16;

/** The one method of an Analytics Engine dataset binding this uses. */
export interface ActivityDataset {
  writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }): void;
}

export class AnalyticsActivity implements Activity {
  private key: Promise<CryptoKey> | null = null;

  constructor(
    private readonly dataset: ActivityDataset,
    private readonly salt: string,
  ) {}

  async record(event: ActivityEvent): Promise<void> {
    try {
      const actor = event.actor === null ? NO_ACTOR : await this.hash(event.actor);
      this.dataset.writeDataPoint({ indexes: [actor], blobs: [ACTIVITY_APP, event.action, event.detail ?? ''], doubles: [1] });
    } catch {
      // Counting is best effort: a failed write costs one data point.
    }
  }

  private async hash(actor: string): Promise<string> {
    const encoder = new TextEncoder();
    this.key ??= crypto.subtle.importKey('raw', encoder.encode(this.salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await this.key, encoder.encode(`${ACTIVITY_APP}:${actor}`)));
    return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, HASH_HEX_CHARS);
  }
}
