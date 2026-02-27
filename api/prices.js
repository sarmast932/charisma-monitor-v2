// api/prices.js - FINAL: Fast Fail + Always Return Cache
// CommonJS | Vercel Hobby Compatible | Max Execution: ~3s

const { Redis } = require('@upstash/redis');

// Configuration - Conservative for Speed
const CONFIG = {
  CHARISMA_URL: 'https://inv.charisma.ir/pub/Plans',
  FETCH_TIMEOUT: 2000, // 2 seconds max per request
  CACHE_FALLBACK: true // Always return cache if live fails
};

// Redis Client (Singleton)
let redisClient = null;
function getRedis() {
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env.REDIS_URL,
      token: process.env.REDIS_TOKEN,
    });
  }
  return redisClient;
}

// Send Telegram Alert (Fire-and-forget, no await in main flow)
async function sendTelegram(message) {
  const { BOT_TOKEN, CHAT_ID } = process.env;
  if (!BOT_TOKEN || !CHAT_ID) return;
  
  // Fire-and-forget: don't wait for response
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    })
  }).catch(e => console.error('Telegram:', e.message));
}

// Fetch Single Price - Fast Fail
async function fetchPriceFast(asset) {
  const url = `${CONFIG.CHARISMA_URL}/${asset}`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const json = await response.json();
    const data = json?.data?.latestIndexPrice;
    
    if (!data?.index) {
      throw new Error('Invalid response');
    }
    
    const priceRial = parseFloat(data.index);
    const change = parseFloat(data.value);
    
    return {
      priceToman: priceRial / 10,
      change: Math.abs(change) < 10 ? change * 100 : change,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    // Fast fail: don't retry, just throw
    throw new Error(`${asset}: ${error.message}`);
  }
}

// Get Any Cache (Even Stale)
async function getAnyCache(redis) {
  try {
    const cached = await redis.get('latest');
    if (cached?.gold?.price24k) {
      const age = Math.round((Date.now() - new Date(cached.lastUpdated).getTime()) / 1000);
      return { ...cached, source: 'cached', cacheAge: age };
    }
  } catch (e) {
    console.error('Cache read:', e.message);
  }
  return null;
}

// Main Handler - Fast & Safe
module.exports = async function handler(req, res) {
  const startTime = Date.now();
  console.log('🚀 /prices called');
  
  try {
    // Validate env fast
    if (!process.env.REDIS_URL || !process.env.REDIS_TOKEN) {
      return res.status(500).json({ success: false, error: 'Missing Redis config' });
    }
    
    const redis = getRedis();
    let gold, silver, source = 'live', alertSent = false;
    
    // Try live fetch with parallel requests + timeout
    try {
      const [g, s] = await Promise.all([
        fetchPriceFast('Gold'),
        fetchPriceFast('Silver')
      ]);
      gold = g;
      silver = s;
      console.log(`💰 Live fetched in ${Date.now() - startTime}ms`);
    } catch (fetchError) {
      console.warn(`⚠️ Live failed: ${fetchError.message}`);
      
      // Fallback: get ANY cache (even stale)
      const cached = await getAnyCache(redis);
      
      if (CONFIG.CACHE_FALLBACK && cached) {
        gold = cached.gold;
        silver = cached.silver;
        source = 'cached';
        console.log(`📦 Cache fallback (age: ${cached.cacheAge}s)`);
      } else {
        // No cache available - return clear error
        return res.status(503).json({
          success: false,
          error: 'Service temporarily unavailable',
          hint: 'Charisma API may be blocking this region. Try again in 1 minute.',
          elapsed: Date.now() - startTime
        });
      }
    }
    
    // Calculate 18K gold
    const gold18k = gold.priceToman * 0.75;
    
    // Send alert ONLY if we have fresh data (non-blocking)
    if (source === 'live') {
      try {
        const lastGold = await redis.get('last_gold');
        const lastAlert = await redis.get('last_alert_time') || 0;
        const now = Math.floor(Date.now() / 1000);
        
        if (lastGold) {
          const diff = Math.abs(gold.priceToman - lastGold.price);
          const pct = Math.abs((gold.priceToman - lastGold.price) / lastGold.price * 100);
          
          if (diff > 100000 || pct > 0.5) {
            if (now - lastAlert > 300) {
              sendTelegram(`🥇 طلا: ${Number(lastGold.price).toLocaleString('fa-IR')} → ${Number(gold.priceToman).toLocaleString('fa-IR')}\nΔ: ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`);
              await redis.set('last_alert_time', now);
              alertSent = true;
            }
          }
        }
        
        // Update cache with fresh data (non-blocking best effort)
        await Promise.all([
          redis.set('last_gold', { price: gold.priceToman, change: gold.change, timestamp: gold.timestamp }),
          redis.set('last_silver', { price: silver.priceToman, change: silver.change, timestamp: silver.timestamp }),
          redis.set('latest', {
            gold: { price24k: gold.priceToman, price18k: gold18k, change: gold.change },
            silver: { price: silver.priceToman, change: silver.change },
            alertSent,
            lastUpdated: new Date().toISOString()
          })
        ]).catch(e => console.error('Cache write:', e.message));
        
      } catch (alertError) {
        console.error('Alert logic:', alertError.message);
        // Don't fail the response for alert errors
      }
    }
    
    // Success response
    return res.status(200).json({
      success: true,
      source,
      cacheAge: source === 'cached' ? (await getAnyCache(redis))?.cacheAge : 0,
      gold: { price24k: gold.priceToman, price18k: gold18k, change: gold.change },
      silver: { price: silver.priceToman, change: silver.change },
      alertSent,
      timestamp: gold.timestamp || new Date().toISOString(),
      elapsed: Date.now() - startTime
    });
    
  } catch (error) {
    console.error('❌ Handler error:', error.message);
    
    // Last resort: try to return any cache
    try {
      const redis = getRedis();
      const stale = await getAnyCache(redis);
      if (stale) {
        return res.status(200).json({
          success: true,
          source: 'cached-stale',
          warning: 'Live fetch failed, showing cached data',
          ...stale,
          elapsed: Date.now() - startTime
        });
      }
    } catch (e) { /* ignore */ }
    
    // Final error response
    return res.status(500).json({
      success: false,
      error: error.message,
      elapsed: Date.now() - startTime
    });
  }
};