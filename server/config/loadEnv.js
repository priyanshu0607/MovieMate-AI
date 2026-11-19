import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
const result = dotenv.config({ path: envPath, override: true });

if (result.error && result.error.code !== 'ENOENT') {
  console.error(`[config] Could not load ${envPath}: ${result.error.message}`);
}
if (result.error?.code === 'ENOENT') {
  console.warn(`[config] No server/.env file found at ${envPath}`);
} else {
  console.log(`[config] Loaded server/.env; TMDB key: ${process.env.TMDB_API_KEY?.trim() ? 'present' : 'missing'}`);
}
