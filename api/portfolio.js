import { getRedis } from '../lib/redis.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { goldQty, goldAvg, silverQty, silverAvg } = await req.json();
    const redis = getRedis();
    
    // دریافت آخرین قیمت‌ها
    const latestPrices = await redis.get('latest_prices');
    
    if (!latestPrices) {
      return res.status(404).json({ error: 'No price data available' });
    }
    
    const goldPrice = latestPrices.gold.price18k;
    const silverPrice = latestPrices.silver.price;
    
    // محاسبات
    const goldValue = goldPrice * goldQty;
    const silverValue = silverPrice * silverQty;
    const totalValue = goldValue + silverValue;
    
    const goldCost = goldAvg * goldQty;
    const silverCost = silverAvg * silverQty;
    const totalCost = goldCost + silverCost;
    
    // کسر 1% کارمزد فروش
    const fee = totalValue * 0.01;
    const netProfit = totalValue - totalCost - fee;
    const returnPercent = (netProfit / totalCost) * 100;
    
    // نقطه سر‌به‌سر
    const breakevenGold = totalCost / (goldQty * 0.99);
    
    return res.status(200).json({
      success: true,
      portfolio: {
        totalValue: Math.round(totalValue),
        totalCost: Math.round(totalCost),
        netProfit: Math.round(netProfit),
        returnPercent: returnPercent.toFixed(2),
        breakevenGold: Math.round(breakevenGold),
        gold: {
          value: Math.round(goldValue),
          cost: Math.round(goldCost),
          profit: Math.round(goldValue - goldCost - (goldValue * 0.01))
        },
        silver: {
          value: Math.round(silverValue),
          cost: Math.round(silverCost),
          profit: Math.round(silverValue - silverCost - (silverValue * 0.01))
        }
      },
      prices: latestPrices
    });
    
  } catch (error) {
    console.error('❌ Portfolio Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}