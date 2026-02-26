// api/prices.js - CommonJS Version for Vercel Compatibility
const { Redis } = require('@upstash/redis');

// آستانه‌ها
const PRICE_CHANGE_ABSOLUTE = 100000; // 100,000 تومان
const PRICE_CHANGE_PERCENT = 0.5; // 0.5%
const SPAM_PREVENTION_WINDOW = 300; // 5 دقیقه
const MAX_RETRIES = 2;

// اتصال به Redis
function getRedis() {
  return new Redis({
    url: process.env.REDIS_URL,
    token: process.env.REDIS_TOKEN,
  });
}

// ارسال به تلگرام
async function sendTelegram(message) {
  const { BOT_TOKEN, CHAT_ID } = process.env;
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('⚠️ Telegram: credentials missing');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chat_id: CHAT_ID, 
        text: message, 
        parse_mode: 'Markdown' 
      })
    });
    console.log('📩 Telegram:', res.ok ? 'Sent' : 'Failed');
  } catch (e) { 
    console.error('Telegram Error:', e.message); 
  }
}

// دریافت قیمت از کاریزما با Retry
async function fetchPrice(asset, retries = 0) {
  const url = `https://inv.charisma.ir/pub/Plans/${asset}`;
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'fa-IR,fa;q=0.9,en-US;q=0.8',
    'Referer': 'https://inv.charisma.ir/',
    'Origin': 'https://inv.charisma.ir',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  try {
    console.log(`🔄 Fetching ${asset} (attempt ${retries + 1})...`);
    
    const response = await fetch(url, { headers, method: 'GET', timeout: 10000 });
    
    if (!response.ok) {
      if (response.status === 404 && retries < MAX_RETRIES) {
        const delay = 500 + Math.random() * 500;
        console.log(`⚠️ ${asset}: HTTP ${response.status}, retrying in ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return fetchPrice(asset, retries + 1);
      }
      throw new Error(`Charisma API: HTTP ${response.status}`);
    }
    
    const json = await response.json();
    const data = json?.data;
    
    if (!data?.latestIndexPrice?.index) {
      console.error('❌ Invalid response:', JSON.stringify(json).slice(0, 150));
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
    if (retries < MAX_RETRIES && (error.message.includes('404') || error.message.includes('network'))) {
      const delay = 500 + Math.random() * 500;
      console.log(`⚠️ ${asset}: ${error.message}, retrying...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchPrice(asset, retries + 1);
    }
    throw error;
  }
}

// Handler اصلی
module.exports = async function handler(req, res) {
  console.log('🚀 API /prices called');
  
  try {
    // بررسی Environment Variables
    const env = {
      hasRedisUrl: !!process.env.REDIS_URL,
      hasRedisToken: !!process.env.REDIS_TOKEN,
      hasBotToken: !!process.env.BOT_TOKEN,
      hasChatId: !!process.env.CHAT_ID
    };
    console.log('🔍 Env check:', env);
    
    if (!env.hasRedisUrl || !env.hasRedisToken) {
      throw new Error('Missing REDIS_URL or REDIS_TOKEN in environment');
    }
    
    const redis = getRedis();
    
    // دریافت قیمت‌ها
    const [gold, silver] = await Promise.all([
      fetchPrice('Gold'),
      fetchPrice('Silver')
    ]);
    
    console.log(`💰 Gold: ${gold.priceToman.toLocaleString()} T, Silver: ${silver.priceToman.toLocaleString()} T`);
    
    const gold18k = gold.priceToman * 0.75;
    
    // بررسی تغییر برای هشدار تلگرام
    const lastGold = await redis.get('last_gold');
    const lastAlert = await redis.get('last_alert_time') || 0;
    const now = Math.floor(Date.now() / 1000);
    
    let alertSent = false;
    if (lastGold) {
      const diff = Math.abs(gold.priceToman - lastGold.price);
      const pct = Math.abs((gold.priceToman - lastGold.price) / lastGold.price * 100);
      
      if ((diff > PRICE_CHANGE_ABSOLUTE || pct > PRICE_CHANGE_PERCENT) && 
          (now - lastAlert) > SPAM_PREVENTION_WINDOW) {
        
        const msg = `🥇 **تغییر قیمت طلا**\n` +
          `قدیم: ${Number(lastGold.price).toLocaleString('fa-IR')} تومان\n` +
          `جدید: ${Number(gold.priceToman).toLocaleString('fa-IR')} تومان\n` +
          `تغییر: ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
        
        await sendTelegram(msg);
        await redis.set('last_alert_time', now);
        alertSent = true;
        console.log('🔔 Alert sent to Telegram');
      }
    }
    
    // ذخیره در Redis
    await redis.set('last_gold', { 
      price: gold.priceToman, 
      change: gold.change, 
      timestamp: gold.timestamp 
    });
    await redis.set('last_silver', { 
      price: silver.priceToman, 
      change: silver.change, 
      timestamp: silver.timestamp 
    });
    await redis.set('latest', { 
      gold: { price24k: gold.priceToman, price18k: gold18k, change: gold.change }, 
      silver: { price: silver.priceToman, change: silver.change },
      alertSent,
      lastUpdated: new Date().toISOString()
    });
    
    console.log('✅ Success');
    
    // پاسخ موفق
    return res.status(200).json({ 
      success: true, 
      gold: { 
        price24k: gold.priceToman, 
        price18k: gold18k, 
        change: gold.change 
      }, 
      silver: { 
        price: silver.priceToman, 
        change: silver.change 
      },
      alertSent,
      timestamp: gold.timestamp
    });
    
  } catch (error) {
    console.error('❌ CRITICAL ERROR:', error.message);
    console.error('Stack:', error.stack?.split('\n').slice(0, 3).join('\n'));
    
    // پاسخ خطا با اطلاعات دیباگ
    return res.status(500).json({ 
      success: false, 
      error: error.message,
      env: {
        hasRedisUrl: !!process.env.REDIS_URL,
        hasRedisToken: !!process.env.REDIS_TOKEN
      },
      hint: 'Check Vercel Functions logs for details'
    });
  }
};