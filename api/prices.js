import { getRedis } from '../lib/redis.js';

const PRICE_CHANGE_ABSOLUTE = 100000;
const PRICE_CHANGE_PERCENT = 0.5;
const SPAM_PREVENTION_WINDOW = 300;

async function sendTelegram(message) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CHAT_ID = process.env.CHAT_ID;
  
  if (!BOT_TOKEN || !CHAT_ID) return;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      }),
    });
  } catch (error) {
    console.error('Telegram Error:', error.message);
  }
}

async function fetchPriceFromCharisma(asset) {
  const url = `https://inv.charisma.ir/pub/Plans/${asset}`;
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    const priceData = data.data;
    
    if (!priceData || !priceData.latestIndexPrice) {
      throw new Error('Invalid data structure');
    }
    
    const priceRial = parseFloat(priceData.latestIndexPrice.index);
    const change = parseFloat(priceData.latestIndexPrice.value);
    
    return {
      priceRial,
      priceToman: priceRial / 10,
      change: Math.abs(change) < 10 ? change * 100 : change,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error(`Error fetching ${asset}:`, error.message);
    throw error;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const redis = getRedis();
    
    const [goldData, silverData] = await Promise.all([
      fetchPriceFromCharisma('Gold'),
      fetchPriceFromCharisma('Silver')
    ]);
    
    const gold18k = goldData.priceToman * 0.75;
    
    const lastGold = await redis.get('last_gold_price');
    const lastSilver = await redis.get('last_silver_price');
    const lastAlertTime = await redis.get('last_alert_time') || 0;
    
    const now = Math.floor(Date.now() / 1000);
    let shouldAlert = false;
    let alertMessages = [];
    
    if (lastGold) {
      const goldDiff = Math.abs(goldData.priceToman - lastGold.price);
      const goldPercent = Math.abs((goldData.priceToman - lastGold.price) / lastGold.price * 100);
      
      if ((goldDiff > PRICE_CHANGE_ABSOLUTE || goldPercent > PRICE_CHANGE_PERCENT) && 
          (now - lastAlertTime) > SPAM_PREVENTION_WINDOW) {
        shouldAlert = true;
        alertMessages.push(`🥇 **تغییر قیمت طلا**\nقدیم: ${Number(lastGold.price).toLocaleString()}\nجدید: ${Number(goldData.priceToman).toLocaleString()}`);
      }
    }
    
    if (lastSilver) {
      const silverDiff = Math.abs(silverData.priceToman - lastSilver.price);
      const silverPercent = Math.abs((silverData.priceToman - lastSilver.price) / lastSilver.price * 100);
      
      if ((silverDiff > PRICE_CHANGE_ABSOLUTE || silverPercent > PRICE_CHANGE_PERCENT) && 
          (now - lastAlertTime) > SPAM_PREVENTION_WINDOW) {
        shouldAlert = true;
        alertMessages.push(`🥈 **تغییر قیمت نقره**\nقدیم: ${Number(lastSilver.price).toLocaleString()}\nجدید: ${Number(silverData.priceToman).toLocaleString()}`);
      }
    }
    
    if (shouldAlert && alertMessages.length > 0) {
      await sendTelegram(alertMessages.join('\n\n'));
      await redis.set('last_alert_time', now);
    }
    
    await redis.set('last_gold_price', {
      price: goldData.priceToman,
      price18k: gold18k,
      change: goldData.change,
      timestamp: goldData.timestamp
    });
    
    await redis.set('last_silver_price', {
      price: silverData.priceToman,
      change: silverData.change,
      timestamp: silverData.timestamp
    });
    
    await redis.set('latest_prices', {
      gold: { price24k: goldData.priceToman, price18k: gold18k, change: goldData.change },
      silver: { price: silverData.priceToman, change: silverData.change },
      lastUpdated: goldData.timestamp,
      alertSent: shouldAlert
    });
    
    return res.status(200).json({
      success: true,
      gold: { price24k: goldData.priceToman, price18k: gold18k, change: goldData.change },
      silver: { price: silverData.priceToman, change: silverData.change },
      lastUpdated: goldData.timestamp,
      alertSent: shouldAlert
    });
    
  } catch (error) {
    console.error('API Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}