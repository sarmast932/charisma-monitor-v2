import { Redis } from '@upstash/redis';

// آستانه‌ها
const PRICE_CHANGE_ABSOLUTE = 100000;
const PRICE_CHANGE_PERCENT = 0.5;
const SPAM_PREVENTION_WINDOW = 300;

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
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' })
    });
    console.log('📩 Telegram:', res.ok ? 'Sent' : 'Failed');
  } catch (e) { console.error('Telegram Error:', e.message); }
}

// دریافت قیمت از کاریزما
async function fetchPrice(asset) {
  console.log(`🔄 Fetching ${asset} from Charisma...`);
  const res = await fetch(`https://inv.charisma.ir/pub/Plans/${asset}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`Charisma API: HTTP ${res.status}`);
  const json = await res.json();
  const data = json.data;
  if (!data?.latestIndexPrice?.index) throw new Error('Invalid Charisma response');
  
  const priceRial = parseFloat(data.latestIndexPrice.index);
  const change = parseFloat(data.latestIndexPrice.value);
  return {
    priceToman: priceRial / 10,
    change: Math.abs(change) < 10 ? change * 100 : change,
    timestamp: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  console.log('🚀 API /prices called');
  
  try {
    // بررسی Environment Variables
    if (!process.env.REDIS_URL || !process.env.REDIS_TOKEN) {
      throw new Error('Missing REDIS_URL or REDIS_TOKEN');
    }
    if (!process.env.BOT_TOKEN || !process.env.CHAT_ID) {
      console.log('⚠️ Telegram credentials missing (non-fatal)');
    }
    
    const redis = getRedis();
    
    // دریافت قیمت‌ها
    const [gold, silver] = await Promise.all([
      fetchPrice('Gold'),
      fetchPrice('Silver')
    ]);
    
    console.log(`💰 Gold: ${gold.priceToman} T, Silver: ${silver.priceToman} T`);
    
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
        await sendTelegram(`🥇 طلا: ${Number(lastGold.price).toLocaleString()} → ${Number(gold.priceToman).toLocaleString()} تومان`);
        await redis.set('last_alert_time', now);
        alertSent = true;
        console.log('🔔 Alert sent');
      }
    }
    
    // ذخیره در Redis
    await redis.set('last_gold', { price: gold.priceToman, change: gold.change });
    await redis.set('last_silver', { price: silver.priceToman, change: silver.change });
    await redis.set('latest', { gold: { price24k: gold.priceToman, price18k: gold18k, change: gold.change }, silver, alertSent });
    
    console.log('✅ Success');
    return res.status(200).json({ success: true, gold: { price24k: gold.priceToman, price18k: gold18k, change: gold.change }, silver, alertSent });
    
  } catch (error) {
    console.error('❌ API Error:', error.message);
    console.error('Stack:', error.stack);
    return res.status(500).json({ success: false, error: error.message, env: { hasRedisUrl: !!process.env.REDIS_URL, hasRedisToken: !!process.env.REDIS_TOKEN } });
  }
}