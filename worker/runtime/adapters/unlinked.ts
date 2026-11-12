// Storage for a pod whose owner has not linked a provider yet.

import { StorageUnavailable } from '../../app/shared/errors.js';
import type { FileStore } from '../../app/storage/ports.js';

export class UnlinkedStore implements FileStore {
  readonly mergesCase = false;
  private fail(): never {
    throw new StorageUnavailable('this pod has no linked storage');
  }
  read = async () => this.fail();
  write = async () => this.fail();
  begin = async () => this.fail();
  remove = async () => this.fail();
  makeFolder = async () => this.fail();
  removeFolder = async () => this.fail();
  namesIn = async () => this.fail();
}
