import { LOCAL_ADMIN_URL, startLocalDb } from '../../../scripts/local-db.mjs';

export default async function globalSetup() {
  if (!process.env.TEST_DATABASE_ADMIN_URL) {
    startLocalDb();
    process.env.TEST_DATABASE_ADMIN_URL = LOCAL_ADMIN_URL;
  }
}
