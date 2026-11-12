// Usage counting. An event says that something happened, and for whom, so
// totals such as people active per day can be kept without recording what
// anyone did. It never carries a path, an address or content.

export type ActivityAction = 'active' | 'signup' | 'pod_created' | 'storage_linked' | 'pod_request';

export interface ActivityEvent {
  /** The id of the pod holding the person's WebID: one per person, however
   * many pods they have. Null when nobody in particular acted. */
  actor: string | null;
  action: ActivityAction;
  /** A fixed word qualifying the action, such as a storage provider. */
  detail?: string;
}

/** Recording never throws and never holds up the caller's work. */
export interface Activity {
  record(event: ActivityEvent): Promise<void>;
}

export const NO_ACTIVITY: Activity = { record: async () => {} };
