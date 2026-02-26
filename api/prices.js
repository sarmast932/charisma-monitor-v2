import { Redis } from '@upstash/redis';

const PRICE_CHANGE_ABSOLUTE = 100000;
const PRICE_CHANGE_PERCENT = 0.5;
const SPAM_PREVENTION_WINDOW = 300;
const MAX_RETRIES = 3;

function getRedis() {
  return new Redis({
    url: process.env.REDIS_URL,
    token: process.env.REDIS_TOKEN,
  });
}

async function sendTelegram(message) {
  const { BOT_TOKEN, CHAT_ID } = process.env;
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' })
    });
  } catch (e) { console.error('Telegram:', e.message); }
}

async function fetchPriceWithRetry(asset, retries = 0) {
  const url = `https://inv.charisma.ir/pub/Plans/${asset}`;
  
  // هدرهای کامل شبیه‌سازی مرورگر واقعی
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Referer': 'https://inv.charisma.ir/',
    'Origin': 'https://inv.charisma.ir',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
  };

  try {
    console.log(`🔄 Fetching ${asset} (attempt ${retries + 1})...`);
    
    const response = await fetch(url, { headers, method: 'GET' });
    
    if (response.status === 404 && retries < MAX_RETRIES) {
      // Retry با تأخیر تصادفی
      const delay = Math.random() * 1000 + 500;
      console.log(`⚠️ 404 received, retrying in ${Math.round(delay)}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchPriceWithRetry(asset, retries + 1);
    }
    
    if (!response.ok) {
      throw new Error(`Charisma API: HTTP ${response.status} ${response.statusText}`);
    }
    
    const json = await response.json();
    const data = json.data;
    
    if (!data?.latestIndexPrice?.index) {
      console.error('❌ Invalid response structure:', JSON.stringify(json).slice(0, 200));
      throw new Error('Invalid Charisma response structure');
    }
    
    const priceRial = parseFloat(data.latestIndexPrice.index);
    const change = parseFloat(data.latestIndexPrice.value);
    
    return {
      priceToman: priceRial / 10,
      change: Math.abs(change) < 10 ? change * 100 : change,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    if (retries < MAX_RETRIES && (error.message.includes('404') || error.message.includes('network'))) {
      const delay = Math.random() * 1000 + 500;
      console.log(`⚠️ Error: ${error.message}, retrying...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchPriceWithRetry(asset, retries + 1);
    }
    throw error;
  }
}

export default async function handler(req, res) {
  console.log('🚀 API /prices called from:', req.headers.get('x-vercel-ip-country') || 'unknown');
  
  try {
    // بررسی متغیرهای محیطی
    const envCheck = {
      hasRedisUrl: !!process.env.REDIS_URL,
      hasRedisToken: !!process.env.REDIS_TOKEN,
      hasBotToken: !!process.env.BOT_TOKEN,
      hasChatId: !!process.env.CHAT_ID
    };
    console.log('🔍 Env check:', envCheck);
    
    if (!envCheck.hasRedisUrl || !envCheck.hasRedisToken) {
      throw new Error('Missing Redis credentials');
    }
    
    const redis = getRedis();
    
    // دریافت قیمت‌ها با Retry
    const [gold, silver] = await Promise.all([
      fetchPriceWithRetry('Gold'),
      fetchPriceWithRetry('Silver')
    ]);
    
    console.log(`💰 Gold: ${gold.priceToman.toLocaleString()} T, Silver: ${silver.priceToman.toLocaleString()} T`);
    
    const gold18k = gold.priceToman * 0.75;
    
    // بررسی تغییر برای هشدار
    const lastGold = await redis.get('last_gold');
    const lastAlert = await redis.get('last_alert_time') || 0;
    const now = Math.floor(Date.now() / 1000);
    
    let alertSent = false;
    if (lastGold) {
      const diff = Math.abs(gold.priceToman - lastGold.price);
      const pct = Math.abs((gold.priceToman - lastGold.price) / lastGold.price * 100);
      if ((diff > PRICE_CHANGE_ABSOLUTE || pct > PRICE_CHANGE_PERCENT) && (now - lastAlert) > SPAM_PREVENTION_WINDOW) {
        await sendTelegram(`🥇 طلا: ${Number(lastGold.price).toLocaleString()} → ${Number(gold.priceToman).toLocaleString()} تومان\nتغییر: ${pct.toFixed(2)}%`);
        await redis.set('last_alert_time', now);
        alertSent = true;
        console.log('🔔 Alert sent to Telegram');
      }
    }
    
    // ذخیره در Redis
    await redis.set('last_gold', { price: gold.priceToman, change: gold.change, timestamp: gold.timestamp });
    await redis.set('last_silver', { price: silver.priceToman, change: silver.change, timestamp: silver.timestamp });
    await redis.set('latest', { 
      gold: { price24k: gold.priceToman, price18k: gold18k, change: gold.change }, 
      silver: { price: silver.priceToman, change: silver.change },
      alertSent,
      lastUpdated: new Date().toISOString()
    });
    
    console.log('✅ Success - Response sent');
    return res.status(200).json({ 
      success: true, 
      gold: { price24k: gold.priceToman, price18k: gold18k, change: gold.change }, 
      silver: { price: silver.priceToman, change: silver.change },
      alertSent,
      timestamp: gold.timestamp
    });
    
  } catch (error) {
    console.error('❌ API Error:', error.message);
    console.error('Stack:', error.stack?.split('\n')[1]);
    return res.status(500).json({ 
      success: false, 
      error: error.message,
      env: {
        hasRedisUrl: !!process.env.REDIS_URL,
        hasRedisToken: !!process.env.REDIS_TOKEN
      }
    });
  }
}