import type { Config } from '../config.js';
import type { StorageDriver } from './driver.js';
import { LocalStubStorageDriver } from './local-stub.js';
import { R2StorageDriver } from './r2.js';

export * from './driver.js';
export { LocalStubStorageDriver } from './local-stub.js';
export { R2StorageDriver } from './r2.js';

export async function createStorageDriver(config: Config): Promise<StorageDriver> {
  if (config.storageDriver === 'r2') {
    if (
      !config.r2Endpoint ||
      !config.r2Bucket ||
      !config.r2AccessKeyId ||
      !config.r2SecretAccessKey
    ) {
      throw new Error('R2 storage configuration is incomplete');
    }
    return new R2StorageDriver({
      endpoint: config.r2Endpoint,
      bucket: config.r2Bucket,
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    });
  }

  const stub = new LocalStubStorageDriver();
  await stub.start();
  return stub;
}
