// lib/redis.js - CommonJS
const { Redis } = require('@upstash/redis');

let redisInstance = null;

function getRedis() {
  if (!redisInstance) {
    redisInstance = new Redis({
      url: process.env.REDIS_URL,
      token: process.env.REDIS_TOKEN,
    });
  }
  return redisInstance;
}

module.exports = { getRedis };