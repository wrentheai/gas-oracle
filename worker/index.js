/**
 * Gas Oracle — "Should I fill up today?"
 * Cloudflare Worker + Telegram Bot
 * 
 * Architecture:
 * - EIA API for weekly gas prices (free, no key needed for DEMO)
 * - Trend analysis: compare current vs recent weeks
 * - Day-of-week patterns (Mon/Tue cheapest, Thu/Fri most expensive)
 * - Telegram bot for daily signal delivery
 * - KV for subscriber storage + price cache
 */

const EIA_BASE = 'https://api.eia.gov/v2/petroleum/pri/gnd/data/';

// Region mapping: user-friendly names → EIA codes
const REGIONS = {
  'us': { code: 'NUS', name: 'U.S. Average' },
  'california': { code: 'SCA', name: 'California' },
  'la': { code: 'Y05LA', name: 'Los Angeles' },
  'sf': { code: 'Y05SF', name: 'San Francisco' },
  'houston': { code: 'Y44HO', name: 'Houston' },
  'chicago': { code: 'YORD', name: 'Chicago' },
  'nyc': { code: 'SNY', name: 'New York' },
  'boston': { code: 'YBOS', name: 'Boston' },
  'miami': { code: 'YMIA', name: 'Miami' },
  'denver': { code: 'YDEN', name: 'Denver' },
  'ohio': { code: 'SOH', name: 'Ohio' },
  'florida': { code: 'SFL', name: 'Florida' },
  'dc': { code: 'SWA', name: 'Washington D.C.' },
  'minnesota': { code: 'SMN', name: 'Minnesota' },
  'cleveland': { code: 'YCLE', name: 'Cleveland' },
};

// Day-of-week price patterns (research-backed)
// Index 0=Sunday. Relative price adjustment (cents)
const DAY_PATTERNS = {
  0: -3,  // Sunday: slightly cheaper
  1: -5,  // Monday: cheapest (stations lower after weekend)
  2: -4,  // Tuesday: still low
  3: 0,   // Wednesday: neutral
  4: +4,  // Thursday: rising
  5: +5,  // Friday: peak (weekend travel demand)
  6: +2,  // Saturday: still elevated
};

async function fetchGasPrices(regionCode, weeks = 8, eiaKey = 'DEMO_KEY') {
  // Try regular gas first (EPMRU), then total gasoline (EPM0) as fallback
  for (const product of ['EPMRU', 'EPM0', 'EPM0R']) {
    const url = `${EIA_BASE}?api_key=${eiaKey}&frequency=weekly&data%5B0%5D=value&facets%5Bproduct%5D%5B%5D=${product}&facets%5Bduoarea%5D%5B%5D=${regionCode}&sort%5B0%5D%5Bcolumn%5D=period&sort%5B0%5D%5Bdirection%5D=desc&length=${weeks}`;
    
    const resp = await fetch(url);
    const data = await resp.json();
    
    if (data.response?.data?.length >= 3) {
      return data.response.data.map(d => ({
        period: d.period,
        price: parseFloat(d.value),
      }));
    }
  }
  return null;
}

function analyzeSignal(prices, dayOfWeek) {
  if (!prices || prices.length < 3) return null;
  
  const current = prices[0].price;
  const lastWeek = prices[1].price;
  const twoWeeksAgo = prices[2].price;
  
  // Weekly trend
  const weeklyChange = current - lastWeek;
  const weeklyChangePct = (weeklyChange / lastWeek * 100);
  
  // 4-week trend
  const fourWeekAvg = prices.slice(0, 4).reduce((s, p) => s + p.price, 0) / Math.min(4, prices.length);
  const trend = current > fourWeekAvg ? 'rising' : current < fourWeekAvg ? 'falling' : 'stable';
  
  // Day-of-week adjustment
  const todayAdj = DAY_PATTERNS[dayOfWeek] || 0;
  const tomorrowAdj = DAY_PATTERNS[(dayOfWeek + 1) % 7] || 0;
  const dayAfterAdj = DAY_PATTERNS[(dayOfWeek + 2) % 7] || 0;
  
  // Best day in next 3 days
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const upcoming = [
    { day: dayNames[dayOfWeek], adj: todayAdj, offset: 0 },
    { day: dayNames[(dayOfWeek + 1) % 7], adj: tomorrowAdj, offset: 1 },
    { day: dayNames[(dayOfWeek + 2) % 7], adj: dayAfterAdj, offset: 2 },
  ];
  const bestDay = upcoming.reduce((a, b) => a.adj < b.adj ? a : b);
  
  // Decision logic
  let signal, reason, savings;
  
  if (trend === 'rising' && todayAdj <= tomorrowAdj) {
    signal = 'FILL_UP';
    reason = `Prices trending up (+${weeklyChangePct.toFixed(1)}% this week) and today is cheaper than tomorrow.`;
    savings = Math.abs(todayAdj - Math.max(tomorrowAdj, dayAfterAdj)) / 100 * 15; // 15 gal tank
  } else if (trend === 'falling' && bestDay.offset > 0) {
    signal = 'WAIT';
    reason = `Prices trending down and ${bestDay.day} is typically cheaper.`;
    savings = Math.abs(todayAdj - bestDay.adj) / 100 * 15;
  } else if (todayAdj <= -3) {
    signal = 'FILL_UP';
    reason = `${dayNames[dayOfWeek]} is typically one of the cheapest days to fill up.`;
    savings = Math.abs(todayAdj - 5) / 100 * 15; // vs Friday peak
  } else if (todayAdj >= 4) {
    signal = 'WAIT';
    reason = `${dayNames[dayOfWeek]} is typically one of the most expensive days. Wait until ${bestDay.day}.`;
    savings = Math.abs(todayAdj - bestDay.adj) / 100 * 15;
  } else {
    // Neutral — lean on trend
    if (trend === 'rising') {
      signal = 'FILL_UP';
      reason = `Prices are rising (+${weeklyChangePct.toFixed(1)}% this week). Fill up before they go higher.`;
    } else {
      signal = 'WAIT';
      reason = `Prices are stable/falling. No rush.`;
    }
    savings = Math.abs(weeklyChange) * 15;
  }
  
  return {
    signal,
    reason,
    current,
    lastWeek,
    weeklyChange,
    weeklyChangePct,
    trend,
    savings: Math.max(savings, 0.5).toFixed(2),
    bestDay: bestDay.day,
  };
}

function formatSignal(analysis, regionName) {
  if (!analysis) return "Couldn't get price data for your region. Try /region to change.";
  
  const emoji = analysis.signal === 'FILL_UP' ? '⛽' : '⏳';
  const action = analysis.signal === 'FILL_UP' ? 'Fill up today.' : 'Wait if you can.';
  const arrow = analysis.weeklyChange > 0 ? '📈' : analysis.weeklyChange < 0 ? '📉' : '➡️';
  const changeStr = analysis.weeklyChange > 0 
    ? `+${(analysis.weeklyChange * 100).toFixed(0)}¢` 
    : `${(analysis.weeklyChange * 100).toFixed(0)}¢`;
  
  return `${emoji} ${action}

💰 ${regionName}: $${analysis.current.toFixed(3)}/gal
${arrow} ${changeStr} from last week (${analysis.trend})

${analysis.reason}

${analysis.signal === 'WAIT' ? `Best day coming up: ${analysis.bestDay}` : `Potential savings vs waiting: ~$${analysis.savings}`}`;
}

// Telegram bot handler
async function handleTelegram(request, env) {
  const body = await request.json();
  const message = body.message;
  if (!message?.text) return new Response('ok');
  
  const chatId = message.chat.id;
  const text = message.text.trim().toLowerCase();
  
  // Track bot usage
  const today = new Date().toISOString().slice(0, 10);
  const statsKey = `stats:${today}`;
  const stats = JSON.parse(await env.KV.get(statsKey) || '{}');
  stats.commands = (stats.commands || 0) + 1;
  stats[text.split(' ')[0]] = (stats[text.split(' ')[0]] || 0) + 1;
  stats.unique_users = stats.unique_users || [];
  if (!stats.unique_users.includes(chatId)) stats.unique_users.push(chatId);
  await env.KV.put(statsKey, JSON.stringify(stats), { expirationTtl: 90 * 86400 });

  let reply;
  
  if (text === '/start') {
    reply = `🔮 Gas Oracle — Should you fill up today?

I'll tell you the best time to buy gas based on price trends and day-of-week patterns.

Commands:
/check — Get today's signal
/region <name> — Set your region (la, sf, nyc, chicago, houston, miami, denver, boston, dc, ohio, florida, minnesota, cleveland)
/subscribe — Daily signal at 7am
/unsubscribe — Stop daily signals
/price — Current price + trend
/regions — List all regions

Default region: U.S. Average`;
    
    // Set default region
    await env.KV.put(`user:${chatId}:region`, 'us');
    
  } else if (text === '/check' || text === 'check') {
    const regionKey = await env.KV.get(`user:${chatId}:region`) || 'us';
    const region = REGIONS[regionKey] || REGIONS['us'];
    const prices = await fetchGasPrices(region.code, 8, env.EIA_KEY);
    const dow = new Date().getDay();
    const analysis = analyzeSignal(prices, dow);
    reply = formatSignal(analysis, region.name);
    
  } else if (text === '/regions') {
    reply = '📍 Available regions:\n\n' + 
      Object.entries(REGIONS).map(([k, v]) => `  ${k} → ${v.name}`).join('\n') +
      '\n\nUse: /region <name>';
    
  } else if (text.startsWith('/region')) {
    const parts = text.split(/\s+/);
    const regionKey = parts[1]?.toLowerCase();
    
    if (!regionKey) {
      const currentKey = await env.KV.get(`user:${chatId}:region`) || 'us';
      reply = `Current region: ${REGIONS[currentKey]?.name || 'U.S. Average'}\n\nUse /region <name> to change. See /regions for options.`;
    } else if (REGIONS[regionKey]) {
      await env.KV.put(`user:${chatId}:region`, regionKey);
      reply = `✅ Region set to ${REGIONS[regionKey].name}. Use /check for today's signal.`;
    } else {
      reply = `Unknown region "${regionKey}". Use /regions to see options.`;
    }
    
  } else if (text === '/subscribe') {
    await env.KV.put(`sub:${chatId}`, JSON.stringify({ 
      region: await env.KV.get(`user:${chatId}:region`) || 'us',
      subscribed: new Date().toISOString(),
    }));
    reply = '✅ Subscribed! You\'ll get a daily signal at 7am your time.\n\n(Note: daily alerts coming soon — for now use /check)';
    
  } else if (text === '/unsubscribe') {
    await env.KV.delete(`sub:${chatId}`);
    reply = '👋 Unsubscribed from daily signals.';
    
  } else if (text === '/price') {
    const regionKey = await env.KV.get(`user:${chatId}:region`) || 'us';
    const region = REGIONS[regionKey] || REGIONS['us'];
    const prices = await fetchGasPrices(region.code, 8, env.EIA_KEY);
    
    if (prices && prices.length >= 4) {
      reply = `💰 ${region.name} Gas Prices\n\n`;
      prices.slice(0, 6).forEach(p => {
        reply += `  ${p.period}: $${p.price.toFixed(3)}/gal\n`;
      });
      const change = ((prices[0].price - prices[3].price) / prices[3].price * 100).toFixed(1);
      reply += `\n4-week change: ${change > 0 ? '+' : ''}${change}%`;
    } else {
      reply = 'Could not fetch price data.';
    }
    
  } else {
    reply = 'Use /check for today\'s signal or /start for help.';
  }
  
  // Send reply
  try {
    const sendResp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply,
      }),
    });
    const sendResult = await sendResp.json();
    if (!sendResult.ok) {
      console.error('Telegram send error:', JSON.stringify(sendResult));
    }
  } catch (e) {
    console.error('Send failed:', e.message);
  }
  
  return new Response('ok');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Telegram webhook
    if (url.pathname === '/webhook') {
      return handleTelegram(request, env);
    }
    
    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', bot: 'Gas Oracle' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // Stats endpoint
    if (url.pathname === '/api/stats') {
      const today = new Date().toISOString().slice(0, 10);
      const days = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const s = JSON.parse(await env.KV.get(`stats:${d}`) || '{}');
        days.push({ date: d, commands: s.commands || 0, users: s.unique_users?.length || 0 });
      }
      return new Response(JSON.stringify({ days }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // History endpoint — get historical price data
    if (url.pathname === '/history') {
      const days = parseInt(url.searchParams.get('days') || '30');
      const history = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const entry = await env.KV.get(`history:${d}`, { type: 'json' });
        if (entry) history.push(entry);
      }
      return new Response(JSON.stringify({ count: history.length, data: history }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
      });
    }

    // API endpoint — check signal for a region
    if (url.pathname === '/api/check') {
      const region = url.searchParams.get('region') || 'us';
      const r = REGIONS[region] || REGIONS['us'];
      const prices = await fetchGasPrices(r.code, 8, env.EIA_KEY);
      const dow = new Date().getDay();
      const analysis = analyzeSignal(prices, dow);
      
      return new Response(JSON.stringify({ region: r.name, ...analysis }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // OG image — served from KV (uploaded daily by cron)
    if (url.pathname === '/og-image') {
      const ogImg = await env.KV.get('og-image', { type: 'arrayBuffer' });
      if (ogImg) {
        return new Response(ogImg, {
          headers: { 
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=3600',
          },
        });
      }
      // Fallback: redirect to a static placeholder
      return new Response('No OG image yet', { status: 404 });
    }

    // Landing page — reads cached data from KV
    if (url.pathname === '/') {
      let analysis = JSON.parse(await env.KV.get('cached-signal') || 'null');
      
      // Fallback: fetch live if no cache
      if (!analysis) {
        const usPrices = await fetchGasPrices(REGIONS["us"].code, 8, env.EIA_KEY);
        const dow = new Date().getDay();
        analysis = analyzeSignal(usPrices, dow);
      }
      
      const isFillUp = analysis?.signal === 'FILL_UP';
      const signalText = isFillUp ? 'Fill Up Today' : "Wait — Don't Buy Gas Yet";
      const priceStr = analysis ? `$${analysis.current.toFixed(2)}/gal` : '';
      const changeStr = analysis ? (analysis.weeklyChange > 0 
        ? `up ${(analysis.weeklyChange * 100).toFixed(0)}¢` 
        : `down ${Math.abs(analysis.weeklyChange * 100).toFixed(0)}¢`) : '';
      const trendStr = analysis?.trend || '';
      
      const ogTitle = `⛽ ${signalText} | ${priceStr} (${changeStr}) — Gas Oracle`;
      const ogDescription = analysis 
        ? `U.S. Average: ${priceStr} (${changeStr} this week, ${trendStr}). ${analysis.reason}` 
        : 'Should you fill up today? Free daily gas price signals.';
      const themeColor = isFillUp ? '#22c55e' : '#ef4444';

      return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${ogTitle}</title>

  <!-- Open Graph (Facebook, iMessage, etc.) -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://thegasoracle.com">
  <meta property="og:title" content="${ogTitle}">
  <meta property="og:description" content="${ogDescription}">
  <meta property="og:site_name" content="Gas Oracle">
  <meta property="og:image" content="https://thegasoracle.com/og-image">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${ogTitle}">
  <meta name="twitter:description" content="${ogDescription}">
  <meta name="twitter:image" content="https://thegasoracle.com/og-image">

  <meta name="theme-color" content="${themeColor}">
  <meta name="description" content="${ogDescription}">

  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 480px; padding: 40px 20px; text-align: center; }
    h1 { font-size: 3rem; margin-bottom: 8px; }
    .sub { color: #888; font-size: 1.1rem; margin-bottom: 40px; }
    .signal { background: #111; border: 1px solid #222; border-radius: 16px; padding: 32px; margin-bottom: 32px; text-align: left; }
    .signal-label { font-size: 0.85rem; color: #666; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    .signal-action { font-size: 1.8rem; font-weight: 700; margin-bottom: 12px; }
    .fill { color: #22c55e; }
    .wait { color: #f59e0b; }
    .price { font-size: 1.2rem; color: #ccc; margin-bottom: 8px; }
    .reason { color: #888; font-size: 0.95rem; line-height: 1.5; }
    .cta { display: inline-block; background: #2563eb; color: #fff; padding: 16px 32px; border-radius: 12px; font-size: 1.1rem; font-weight: 600; text-decoration: none; margin-top: 8px; }
    .cta:hover { background: #1d4ed8; }
    .share { background: #111; border: 1px solid #222; border-radius: 16px; padding: 24px; margin-top: 32px; text-align: left; }
    .share-label { font-size: 0.85rem; color: #666; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
    .share-title, .share-body { background: #0a0a0a; border: 1px solid #333; border-radius: 8px; padding: 12px; color: #eee; font-size: 0.95rem; line-height: 1.5; margin-bottom: 8px; width: 100%; resize: none; font-family: inherit; }
    .share-title { height: 44px; }
    .share-body { height: 160px; }
    .copy-btn { background: #333; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 0.85rem; margin-right: 8px; margin-top: 4px; }
    .copy-btn:hover { background: #444; }
    .copy-btn.copied { background: #22c55e; }
    .footer { color: #444; font-size: 0.8rem; margin-top: 40px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>⛽ Gas Oracle</h1>
    <p class="sub">Should you fill up today?</p>
    
    <div class="signal">
      <div class="signal-label">Today's Signal</div>
      <div class="signal-action ${isFillUp ? 'fill' : 'wait'}">${isFillUp ? '⛽ Fill up today' : '⏳ Wait if you can'}</div>
      <div class="price">U.S. Average: ${priceStr} ${analysis.weeklyChange > 0 ? '📈' : '📉'} ${analysis.weeklyChange > 0 ? '+' : ''}${(analysis.weeklyChange * 100).toFixed(0)}¢/wk</div>
      <div class="reason">${analysis.reason}</div>
    </div>
    
    <a class="cta" href="https://t.me/GasOracle2_bot">Get daily signals on Telegram →</a>
    
    <p style="margin-top:24px;"><a href="#" onclick="document.getElementById('shareBox').style.display='block';this.style.display='none';return false;" style="color:#555;font-size:0.85rem;">📋 Copy post for Facebook/Reddit</a></p>
    <div class="share" id="shareBox" style="display:none;">
      <div class="share-label">📋 Ready-to-post (Facebook, Reddit, etc.)</div>
      <textarea class="share-title" id="shareTitle" readonly>${isFillUp ? 'FILL UP TODAY -- gas is still climbing' : 'HOLD OFF ON GAS -- prices are dropping'}</textarea>
      <button class="copy-btn" onclick="copyText('shareTitle', this)">Copy title</button>
      <textarea class="share-body" id="shareBody" readonly>${isFillUp
        ? `U.S. average just hit ${priceStr}, up ${Math.abs(analysis.weeklyChange * 100).toFixed(0)} cents from last week and still trending upward. If your tank is getting low, today is a better day to fill up than waiting. Historically, Monday and Tuesday tend to be the cheapest days of the week to buy gas, while Thursday and Friday are the most expensive because of weekend travel demand. Prices have been rising steadily for the past few weeks and there is no sign of that slowing down yet. Do not get caught filling up on Friday at the peak.`
        : `U.S. average is at ${priceStr}, down ${Math.abs(analysis.weeklyChange * 100).toFixed(0)} cents from last week and still falling. If you can hold off on filling up, prices should keep dropping. Historically, Monday and Tuesday tend to be the cheapest days of the week to buy gas. The current trend suggests waiting a few more days could save you even more at the pump. No need to rush -- the price is moving in your favor right now.`
      }</textarea>
      <button class="copy-btn" onclick="copyText('shareBody', this)">Copy body</button>
      <button class="copy-btn" onclick="copyText('shareTitle', this); copyText('shareBody', this)">Copy both</button>
    </div>
    
    <p class="footer">Free. No app. Just a daily text telling you when to buy gas.<br>Powered by EIA data + price pattern analysis.${analysis.lastUpdated ? '<br>Last updated: ' + analysis.lastUpdated.replace('T', ' ').slice(0, 16) + ' UTC' : ''}</p>
  </div>
  <script>
    function copyText(id, btn) {
      const el = document.getElementById(id);
      navigator.clipboard.writeText(el.value).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = btn.dataset.orig || btn.textContent; btn.classList.remove('copied'); }, 2000);
      });
    }
    document.querySelectorAll('.copy-btn').forEach(b => b.dataset.orig = b.textContent);
  </script>
  <script data-goatcounter="https://gasoracle.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>
</body>
</html>`, {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    
    return new Response('Not found', { status: 404 });
  },

  // Hourly cron: refresh cached signal data
  async scheduled(event, env, ctx) {
    const prices = await fetchGasPrices(REGIONS["us"].code, 8, env.EIA_KEY);
    const dow = new Date().getDay();
    const analysis = analyzeSignal(prices, dow);
    
    if (analysis) {
      analysis.lastUpdated = new Date().toISOString();
      await env.KV.put('cached-signal', JSON.stringify(analysis), { expirationTtl: 7200 }); // 2hr TTL
      
      // Save historical data daily
      const today = new Date().toISOString().slice(0, 10);
      const historyKey = `history:${today}`;
      const existing = await env.KV.get(historyKey);
      if (!existing) {
        // Fetch all regions for history
        const regionData = {};
        for (const [key, region] of Object.entries(REGIONS)) {
          try {
            const rPrices = await fetchGasPrices(region.code, 8, env.EIA_KEY);
            const rAnalysis = analyzeSignal(rPrices, new Date().getDay());
            if (rAnalysis) {
              regionData[key] = {
                name: region.name,
                price: rAnalysis.current,
                signal: rAnalysis.signal,
                weeklyChange: rAnalysis.weeklyChange,
                trend: rAnalysis.trend,
              };
            }
          } catch (e) {}
        }
        
        const historyEntry = {
          date: today,
          timestamp: new Date().toISOString(),
          us: { price: analysis.current, signal: analysis.signal, weeklyChange: analysis.weeklyChange, trend: analysis.trend },
          regions: regionData,
        };
        await env.KV.put(historyKey, JSON.stringify(historyEntry)); // No TTL — keep forever
      }
      
      console.log(`Cached signal: ${analysis.signal} | $${analysis.current}/gal`);
    }
  },
};
