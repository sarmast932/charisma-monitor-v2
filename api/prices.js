// api/prices.js - FINAL VERSION: CommonJS + Proxy Fallback + Cache
// Compatible with Vercel Hobby Plan

const { Redis } = require('@upstash/redis');

// Configuration
const CONFIG = {
  CHARISMA_BASE: 'https://inv.charisma.ir/pub/Plans',
  // Proxy عمومی که درخواست‌ها را Relay می‌کند (اگر کار نکرد، مستقیم تلاش می‌کند)
  PROXY_URL: 'https://api.allorigins.win/raw?url=',
  PRICE_CHANGE_ABSOLUTE: 100000,
  PRICE_CHANGE_PERCENT: 0.5,
  SPAM_PREVENTION_WINDOW: 300,
  MAX_RETRIES: 2,
  CACHE_MAX_AGE: 600 // 10 minutes
};

// Redis Client
function getRedis() {
  return new Redis({
    url: process.env.REDIS_URL,
    token: process.env.REDIS_TOKEN,
  });
}

// Telegram Sender
async function sendTelegram(message) {
  const { BOT_TOKEN, CHAT_ID } = process.env;
  if (!BOT_TOKEN || !CHAT_ID) return;
  
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
    console.log('📩 Telegram: Sent');
  } catch (e) {
    console.error('Telegram Error:', e.message);
  }
}

// Fetch Price with Proxy Fallback
async function fetchPrice(asset, useProxy = true, retries = 0) {
  const baseUrl = useProxy ? CONFIG.PROXY_URL + encodeURIComponent(CONFIG.CHARISMA_BASE) : CONFIG.CHARISMA_BASE;
  const url = `${baseUrl}/${asset}`;
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'fa-IR,fa;q=0.9',
  };

  try {
    console.log(`🔄 Fetching ${asset} (proxy:${useProxy}, attempt:${retries+1})`);
    
    const response = await fetch(url, { 
      headers, 
      method: 'GET',
      timeout: 8000 
    });
    
    if (!response.ok) {
      // اگر با Proxy هم 404 داد و هنوز retry داریم، بدون Proxy امتحان کن
      if (useProxy && response.status === 404 && retries < CONFIG.MAX_RETRIES) {
        console.log(`⚠️ ${asset}: Proxy failed, trying direct...`);
        return fetchPrice(asset, false, retries + 1);
      }
      // اگر بدون Proxy هم 404 داد و retry داریم، با Proxy دوباره امتحان کن
      if (!useProxy && retries < CONFIG.MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
        return fetchPrice(asset, true, retries + 1);
      }
      throw new Error(`HTTP ${response.status}`);
    }
    
    const json = await response.json();
    const data = json?.data;
    
    if (!data?.latestIndexPrice?.index) {
      console.error('❌ Invalid response structure');
      throw new Error('Invalid Charisma response');
    }
    
    const priceRial = parseFloat(data.latestIndexPrice.index);
    const change = parseFloat(data.latestIndexPrice.value);
    
    return {
      priceToman: priceRial / 10,
      change: Math.abs(change) < 10 ? change * 100 : change,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    // اگر هر دو حالت Proxy و Direct شکست خوردند
    if (retries < CONFIG.MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      return fetchPrice(asset, !useProxy, retries + 1);
    }
    throw error;
  }
}

// Get Cached Data from Redis
async function getCachedData(redis) {
  try {
    const cached = await redis.get('latest');
    if (cached?.gold?.price24k) {
      const age = (Date.now() - new Date(cached.lastUpdated).getTime()) / 1000;
      if (age < CONFIG.CACHE_MAX_AGE) {
        console.log(`📦 Cache hit (age: ${Math.round(age)}s)`);
        return { ...cached, source: 'cached', cacheAge: Math.round(age) };
      }
    }
  } catch (e) {
    console.error('Cache read error:', e.message);
  }
  return null;
}

// Main Handler
module.exports = async function handler(req, res) {
  console.log('🚀 API /prices called');
  
  try {
    // Validate environment
    if (!process.env.REDIS_URL || !process.env.REDIS_TOKEN) {
      throw new Error('Missing REDIS_URL or REDIS_TOKEN');
    }
    
    const redis = getRedis();
    let gold, silver, source = 'live';
    
    // Try to fetch live prices
    try {
      [gold, silver] = await Promise.all([
        fetchPrice('Gold', true),
        fetchPrice('Silver', true)
      ]);
      console.log(`💰 Live: Gold=${gold.priceToman.toLocaleString()}T, Silver=${silver.priceToman.toLocaleString()}T`);
    } catch (fetchError) {
      console.warn(`⚠️ Live fetch failed: ${fetchError.message}. Trying cache...`);
      
      // Fallback to cache
      const cached = await getCachedData(redis);
      if (cached) {
        gold = cached.gold;
        silver = cached.silver;
        source = 'cached';
      } else {
        throw new Error('No live data and no valid cache');
      }
    }
    
    const gold18k = gold.priceToman * 0.75;
    let alertSent = false;
    
    // Send alert only if we have fresh data
    if (source === 'live') {
      const lastGold = await redis.get('last_gold');
      const lastAlert = await redis.get('last_alert_time') || 0;
      const now = Math.floor(Date.now() / 1000);
      
      if (lastGold) {
        const diff = Math.abs(gold.priceToman - lastGold.price);
        const pct = Math.abs((gold.priceToman - lastGold.price) / lastGold.price * 100);
        
        if ((diff > CONFIG.PRICE_CHANGE_ABSOLUTE || pct > CONFIG.PRICE_CHANGE_PERCENT) && 
            (now - lastAlert) > CONFIG.SPAM_PREVENTION_WINDOW) {
          
          const msg = `🥇 **تغییر قیمت طلا**\n` +
            `قدیم: ${Number(lastGold.price).toLocaleString('fa-IR')}\n` +
            `جدید: ${Number(gold.priceToman).toLocaleString('fa-IR')}\n` +
            `Δ: ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
          
          await sendTelegram(msg);
          await redis.set('last_alert_time', now);
          alertSent = true;
          console.log('🔔 Alert sent');
        }
      }
      
      // Update cache with fresh data
      await redis.set('last_gold', { price: gold.priceToman, change: gold.change, timestamp: gold.timestamp });
      await redis.set('last_silver', { price: silver.priceToman, change: silver.change, timestamp: silver.timestamp });
      await redis.set('latest', {
        gold: { price24k: gold.priceToman, price18k: gold18k, change: gold.change },
        silver: { price: silver.priceToman, change: silver.change },
        alertSent,
        lastUpdated: new Date().toISOString()
      });
    }
    
    console.log(`✅ Success (source: ${source})`);
    
    return res.status(200).json({
      success: true,
      source,
      cacheAge: source === 'cached' ? (await getCachedData(redis))?.cacheAge : 0,
      gold: { price24k: gold.priceToman, price18k: gold18k, change: gold.change },
      silver: { price: silver.priceToman, change: silver.change },
      alertSent,
      timestamp: gold.timestamp || new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ CRITICAL:', error.message);
    
    // Last resort: return stale cache if available
    try {
      const redis = getRedis();
      const stale = await redis.get('latest');
      if (stale?.gold?.price24k) {
        console.log('📦 Returning stale cache');
        return res.status(200).json({
          success: true,
          source: 'cached-stale',
          warning: 'Live data unavailable',
          ...stale
        });
      }
    } catch (e) { /* ignore */ }
    
    return res.status(500).json({
      success: false,
      error: error.message,
      hint: 'Charisma API may be blocking non-Iranian IPs'
    });
  }
};