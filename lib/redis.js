import { Redis } from '@upstash/redis';

let redis = null;

export function getRedis() {
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_URL,
      token: process.env.UPSTASH_TOKEN,
    });
  }
  return redis;
}