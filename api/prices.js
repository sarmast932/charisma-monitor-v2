import { getRedis } from '../lib/redis.js';

// آستانه‌های تغییر برای ارسال پیام تلگرام
const PRICE_CHANGE_ABSOLUTE = 100000; // 100,000 تومان
const PRICE_CHANGE_PERCENT = 0.5; // 0.5%
const SPAM_PREVENTION_WINDOW = 300; // 5 دقیقه (ثانیه)

async function sendTelegram(message) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CHAT_ID = process.env.CHAT_ID;
  
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('⚠️ Telegram credentials not set');
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      }),
    });
    
    const result = await response.json();
    console.log('📩 Telegram:', result.ok ? 'Sent' : 'Failed');
    return result.ok;
  } catch (error) {
    console.error('❌ Telegram Error:', error.message);
    return false;
  }
}

async function fetchPriceFromCharisma(asset) {
  const url = `https://inv.charisma.ir/pub/Plans/${asset}`;
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
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
    console.error(`❌ Error fetching ${asset}:`, error.message);
    throw error;
  }
}

export default async function handler(req, res) {
  // فقط اجازه GET و POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const redis = getRedis();
    
    // دریافت قیمت‌ها از کاریزما
    const [goldData, silverData] = await Promise.all([
      fetchPriceFromCharisma('Gold'),
      fetchPriceFromCharisma('Silver')
    ]);
    
    // محاسبه طلای 18 عیار
    const gold18k = goldData.priceToman * 0.75;
    
    // دریافت قیمت‌های قبلی از Redis
    const lastGold = await redis.get('last_gold_price');
    const lastSilver = await redis.get('last_silver_price');
    const lastAlertTime = await redis.get('last_alert_time') || 0;
    
    // بررسی تغییر قیمت برای ارسال تلگرام
    const now = Math.floor(Date.now() / 1000);
    let shouldAlert = false;
    let alertMessages = [];
    
    // بررسی طلا
    if (lastGold) {
      const goldDiff = Math.abs(goldData.priceToman - lastGold.price);
      const goldPercent = Math.abs((goldData.priceToman - lastGold.price) / lastGold.price * 100);
      
      if ((goldDiff > PRICE_CHANGE_ABSOLUTE || goldPercent > PRICE_CHANGE_PERCENT) && 
          (now - lastAlertTime) > SPAM_PREVENTION_WINDOW) {
        shouldAlert = true;
        alertMessages.push(
          `🥇 **تغییر قیمت طلا**\n` +
          `قدیم: ${Number(lastGold.price).toLocaleString()} تومان\n` +
          `جدید: ${Number(goldData.priceToman).toLocaleString()} تومان\n` +
          `تغییر: ${goldDiff > 0 ? '+' : ''}${Number(goldDiff).toLocaleString()} تومان (${goldPercent > 0 ? '+' : ''}${goldPercent.toFixed(2)}%)`
        );
      }
    }
    
    // بررسی نقره
    if (lastSilver) {
      const silverDiff = Math.abs(silverData.priceToman - lastSilver.price);
      const silverPercent = Math.abs((silverData.priceToman - lastSilver.price) / lastSilver.price * 100);
      
      if ((silverDiff > PRICE_CHANGE_ABSOLUTE || silverPercent > PRICE_CHANGE_PERCENT) && 
          (now - lastAlertTime) > SPAM_PREVENTION_WINDOW) {
        shouldAlert = true;
        alertMessages.push(
          `🥈 **تغییر قیمت نقره**\n` +
          `قدیم: ${Number(lastSilver.price).toLocaleString()} تومان\n` +
          `جدید: ${Number(silverData.priceToman).toLocaleString()} تومان\n` +
          `تغییر: ${silverDiff > 0 ? '+' : ''}${Number(silverDiff).toLocaleString()} تومان (${silverPercent > 0 ? '+' : ''}${silverPercent.toFixed(2)}%)`
        );
      }
    }
    
    // ارسال پیام به تلگرام اگر تغییر معنادار بود
    if (shouldAlert && alertMessages.length > 0) {
      const fullMessage = alertMessages.join('\n\n') + `\n\n🕐 ${new Date().toLocaleTimeString('fa-IR')}`;
      await sendTelegram(fullMessage);
      await redis.set('last_alert_time', now);
      console.log('🔔 Alert sent to Telegram');
    }
    
    // ذخیره قیمت‌های جدید در Redis
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
    
    // ذخیره در تاریخچه (برای نمودار)
    await redis.lpush('price_history', JSON.stringify({
      time: goldData.timestamp,
      gold: goldData.priceToman,
      gold18k: gold18k,
      silver: silverData.priceToman,
      goldChange: goldData.change,
      silverChange: silverData.change
    }));
    
    // نگهداری فقط 100 رکورد آخر
    await redis.ltrim('price_history', 0, 99);
    
    // ذخیره آخرین قیمت‌ها برای Frontend
    await redis.set('latest_prices', {
      gold: {
        price24k: goldData.priceToman,
        price18k: gold18k,
        change: goldData.change
      },
      silver: {
        price: silverData.priceToman,
        change: silverData.change
      },
      lastUpdated: goldData.timestamp,
      alertSent: shouldAlert
    });
    
    console.log('✅ Prices updated successfully');
    
    return res.status(200).json({
      success: true,
      gold: {
        price24k: goldData.priceToman,
        price18k: gold18k,
        change: goldData.change
      },
      silver: {
        price: silverData.priceToman,
        change: silverData.change
      },
      lastUpdated: goldData.timestamp,
      alertSent: shouldAlert,
      message: shouldAlert ? 'Alert sent to Telegram' : 'No significant change'
    });
    
  } catch (error) {
    console.error('❌ API Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}