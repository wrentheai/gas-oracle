/**
 * Gas Oracle — "Should I fill up today?"
 * Cloudflare Worker + Telegram Bot
 *
 * Architecture:
 * 1. AAA scrape → today's actual retail price (national + by state)
 * 2. EIA daily spot prices → predict direction (fill now or wait)
 * 3. Day-of-week patterns → refine timing signal
 * 4. Telegram bot for daily signal delivery
 * 5. KV for subscriber storage + price cache
 */

const AAA_NATIONAL_URL = 'https://gasprices.aaa.com/';
const AAA_STATE_URL = 'https://gasprices.aaa.com/state-gas-price-averages/';
const EIA_SPOT_BASE = 'https://api.eia.gov/v2/petroleum/pri/spt/data/';

// State mapping: user-friendly names → AAA state names
const STATES = {
  'us': { aaaName: null, name: 'U.S. Average' },
  'california': { aaaName: 'California', name: 'California' },
  'texas': { aaaName: 'Texas', name: 'Texas' },
  'florida': { aaaName: 'Florida', name: 'Florida' },
  'new york': { aaaName: 'New York', name: 'New York' },
  'ohio': { aaaName: 'Ohio', name: 'Ohio' },
  'illinois': { aaaName: 'Illinois', name: 'Illinois' },
  'pennsylvania': { aaaName: 'Pennsylvania', name: 'Pennsylvania' },
  'georgia': { aaaName: 'Georgia', name: 'Georgia' },
  'michigan': { aaaName: 'Michigan', name: 'Michigan' },
  'colorado': { aaaName: 'Colorado', name: 'Colorado' },
  'arizona': { aaaName: 'Arizona', name: 'Arizona' },
  'minnesota': { aaaName: 'Minnesota', name: 'Minnesota' },
  'washington': { aaaName: 'Washington', name: 'Washington' },
  'oregon': { aaaName: 'Oregon', name: 'Oregon' },
  'nevada': { aaaName: 'Nevada', name: 'Nevada' },
  'indiana': { aaaName: 'Indiana', name: 'Indiana' },
  'virginia': { aaaName: 'Virginia', name: 'Virginia' },
  'maryland': { aaaName: 'Maryland', name: 'Maryland' },
  'dc': { aaaName: 'District of Columbia', name: 'Washington D.C.' },
  'new jersey': { aaaName: 'New Jersey', name: 'New Jersey' },
  'massachusetts': { aaaName: 'Massachusetts', name: 'Massachusetts' },
  'wisconsin': { aaaName: 'Wisconsin', name: 'Wisconsin' },
  'missouri': { aaaName: 'Missouri', name: 'Missouri' },
  'tennessee': { aaaName: 'Tennessee', name: 'Tennessee' },
  'louisiana': { aaaName: 'Louisiana', name: 'Louisiana' },
  'alabama': { aaaName: 'Alabama', name: 'Alabama' },
  'kentucky': { aaaName: 'Kentucky', name: 'Kentucky' },
  'south carolina': { aaaName: 'South Carolina', name: 'South Carolina' },
  'north carolina': { aaaName: 'North Carolina', name: 'North Carolina' },
  'utah': { aaaName: 'Utah', name: 'Utah' },
  'iowa': { aaaName: 'Iowa', name: 'Iowa' },
  'arkansas': { aaaName: 'Arkansas', name: 'Arkansas' },
  'mississippi': { aaaName: 'Mississippi', name: 'Mississippi' },
  'kansas': { aaaName: 'Kansas', name: 'Kansas' },
  'oklahoma': { aaaName: 'Oklahoma', name: 'Oklahoma' },
  'nebraska': { aaaName: 'Nebraska', name: 'Nebraska' },
  'idaho': { aaaName: 'Idaho', name: 'Idaho' },
  'hawaii': { aaaName: 'Hawaii', name: 'Hawaii' },
  'alaska': { aaaName: 'Alaska', name: 'Alaska' },
  'montana': { aaaName: 'Montana', name: 'Montana' },
  'wyoming': { aaaName: 'Wyoming', name: 'Wyoming' },
  'maine': { aaaName: 'Maine', name: 'Maine' },
  'new hampshire': { aaaName: 'New Hampshire', name: 'New Hampshire' },
  'vermont': { aaaName: 'Vermont', name: 'Vermont' },
  'rhode island': { aaaName: 'Rhode Island', name: 'Rhode Island' },
  'connecticut': { aaaName: 'Connecticut', name: 'Connecticut' },
  'delaware': { aaaName: 'Delaware', name: 'Delaware' },
  'west virginia': { aaaName: 'West Virginia', name: 'West Virginia' },
  'new mexico': { aaaName: 'New Mexico', name: 'New Mexico' },
  'south dakota': { aaaName: 'South Dakota', name: 'South Dakota' },
  'north dakota': { aaaName: 'North Dakota', name: 'North Dakota' },
};

// Short aliases for convenience
const STATE_ALIASES = {
  'la': 'louisiana', 'ca': 'california', 'tx': 'texas', 'fl': 'florida',
  'ny': 'new york', 'nyc': 'new york', 'il': 'illinois', 'pa': 'pennsylvania',
  'ga': 'georgia', 'mi': 'michigan', 'co': 'colorado', 'az': 'arizona',
  'mn': 'minnesota', 'wa': 'washington', 'or': 'oregon', 'nv': 'nevada',
  'in': 'indiana', 'va': 'virginia', 'md': 'maryland', 'nj': 'new jersey',
  'ma': 'massachusetts', 'wi': 'wisconsin', 'mo': 'missouri', 'tn': 'tennessee',
  'oh': 'ohio', 'nc': 'north carolina', 'sc': 'south carolina',
  'ky': 'kentucky', 'al': 'alabama', 'ms': 'mississippi', 'ar': 'arkansas',
  'ks': 'kansas', 'ok': 'oklahoma', 'ne': 'nebraska', 'ia': 'iowa',
  'ut': 'utah', 'id': 'idaho', 'hi': 'hawaii', 'ak': 'alaska',
  'mt': 'montana', 'wy': 'wyoming', 'me': 'maine', 'nh': 'new hampshire',
  'vt': 'vermont', 'ri': 'rhode island', 'ct': 'connecticut', 'de': 'delaware',
  'wv': 'west virginia', 'nm': 'new mexico', 'sd': 'south dakota',
  'nd': 'north dakota',
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

// ─── AAA Scraping ───────────────────────────────────────────────────────────

/**
 * Scrape AAA for national average + comparison data.
 * Returns { national, yesterday, weekAgo, monthAgo, yearAgo }
 */
async function scrapeAAANational() {
  const resp = await fetch(AAA_NATIONAL_URL, {
    headers: { 'User-Agent': 'GasOracle/1.0 (price-comparison-bot)' },
  });
  const html = await resp.text();

  const prices = {};

  // Parse rows labeled "Current Avg.", "Yesterday Avg.", etc.
  // Each row: <td>Label</td><td>$Regular</td><td>$MidGrade</td>...
  // We want the first price after the label (Regular column)
  const rowPatterns = [
    { key: 'current', pattern: /Current\s+Avg\.[\s\S]*?\$(\d+\.\d+)/i },
    { key: 'yesterday', pattern: /Yesterday\s+Avg\.[\s\S]*?\$(\d+\.\d+)/i },
    { key: 'weekAgo', pattern: /Week\s+Ago\s+Avg\.[\s\S]*?\$(\d+\.\d+)/i },
    { key: 'monthAgo', pattern: /Month\s+Ago\s+Avg\.[\s\S]*?\$(\d+\.\d+)/i },
    { key: 'yearAgo', pattern: /Year\s+Ago\s+Avg\.[\s\S]*?\$(\d+\.\d+)/i },
  ];

  for (const { key, pattern } of rowPatterns) {
    const match = html.match(pattern);
    if (match) prices[key] = parseFloat(match[1]);
  }

  // Also grab the national average headline as fallback
  const nationalMatch = html.match(/National\s+Average[^$]*\$(\d+\.\d+)/i);
  if (nationalMatch) prices.national = parseFloat(nationalMatch[1]);

  // Ensure current is set
  if (!prices.current && prices.national) {
    prices.current = prices.national;
  }

  return prices;
}

/**
 * Scrape AAA state-by-state prices.
 * Returns { [stateName]: { regular, midGrade, premium, diesel } }
 */
async function scrapeAAAStates() {
  const resp = await fetch(AAA_STATE_URL, {
    headers: { 'User-Agent': 'GasOracle/1.0 (price-comparison-bot)' },
  });
  const html = await resp.text();

  const states = {};

  // Parse each table row: <td>State Name</td><td>$X.XXX</td><td>$X.XXX</td><td>$X.XXX</td><td>$X.XXX</td>
  const rows = html.matchAll(/<tr[^>]*>\s*<td[^>]*>\s*(?:<a[^>]*>)?\s*([A-Za-z\s.]+?)\s*(?:<\/a>)?\s*<\/td>\s*<td[^>]*>\s*\$(\d+\.\d+)\s*<\/td>\s*<td[^>]*>\s*\$(\d+\.\d+)\s*<\/td>\s*<td[^>]*>\s*\$(\d+\.\d+)\s*<\/td>\s*<td[^>]*>\s*\$(\d+\.\d+)\s*<\/td>/gi);

  for (const match of rows) {
    const stateName = match[1].trim();
    states[stateName] = {
      regular: parseFloat(match[2]),
      midGrade: parseFloat(match[3]),
      premium: parseFloat(match[4]),
      diesel: parseFloat(match[5]),
    };
  }

  return states;
}

// ─── EIA Spot Prices (Leading Indicator) ────────────────────────────────────

/**
 * Fetch daily spot prices from EIA.
 * NY Harbor conventional regular gasoline is the benchmark.
 * Returns array of { period, price } sorted newest first.
 */
async function fetchSpotPrices(days = 14, eiaKey = 'DEMO_KEY') {
  const url = `${EIA_SPOT_BASE}?api_key=${eiaKey}&frequency=daily&data[0]=value&facets[product][]=EPMRU&facets[duoarea][]=Y35NY&sort[0][column]=period&sort[0][direction]=desc&length=${days}`;

  const resp = await fetch(url);
  const data = await resp.json();

  if (data.response?.data?.length >= 3) {
    return data.response.data.map(d => ({
      period: d.period,
      price: parseFloat(d.value),
    }));
  }
  return null;
}

// ─── Signal Analysis ────────────────────────────────────────────────────────

/**
 * Analyze spot price trend to predict retail direction.
 * Spot prices lead retail by 1-2 weeks.
 */
function analyzeSpotTrend(spotPrices) {
  if (!spotPrices || spotPrices.length < 5) return null;

  const latest = spotPrices[0].price;
  const threeDayAgo = spotPrices[Math.min(2, spotPrices.length - 1)].price;
  const weekAgo = spotPrices[Math.min(4, spotPrices.length - 1)].price;
  const twoWeekAgo = spotPrices[Math.min(9, spotPrices.length - 1)]?.price || weekAgo;

  // Short-term momentum (3-day)
  const shortChange = latest - threeDayAgo;
  const shortChangePct = (shortChange / threeDayAgo) * 100;

  // Week-over-week
  const weekChange = latest - weekAgo;
  const weekChangePct = (weekChange / weekAgo) * 100;

  // 2-week trend
  const twoWeekChange = latest - twoWeekAgo;

  // 5-day moving average vs latest
  const fiveDayAvg = spotPrices.slice(0, 5).reduce((s, p) => s + p.price, 0) / 5;
  const aboveAvg = latest > fiveDayAvg;

  let direction;
  // Use week-over-week as primary signal (more reliable than 3-day noise)
  if (weekChangePct > 3) {
    direction = 'rising';
  } else if (weekChangePct < -3) {
    direction = 'falling';
  } else if (shortChange > 0.02 && weekChange > 0) {
    direction = 'rising';
  } else if (shortChange < -0.02 && weekChange < 0) {
    direction = 'falling';
  } else {
    direction = 'stable';
  }

  return {
    direction,
    latest,
    shortChange,
    shortChangePct,
    weekChange,
    weekChangePct,
    twoWeekChange,
    aboveAvg,
    spotPrices: spotPrices.slice(0, 7), // last 7 days for display
  };
}

/**
 * Generate the fill/wait signal combining:
 * - AAA retail prices (what you'd pay today)
 * - EIA spot trend (where prices are headed)
 * - Day-of-week patterns
 */
function generateSignal(aaaData, spotTrend, dayOfWeek) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Day-of-week adjustment
  const todayAdj = DAY_PATTERNS[dayOfWeek] || 0;
  const tomorrowAdj = DAY_PATTERNS[(dayOfWeek + 1) % 7] || 0;
  const dayAfterAdj = DAY_PATTERNS[(dayOfWeek + 2) % 7] || 0;

  // Best day in next 3 days
  const upcoming = [
    { day: dayNames[dayOfWeek], adj: todayAdj, offset: 0 },
    { day: dayNames[(dayOfWeek + 1) % 7], adj: tomorrowAdj, offset: 1 },
    { day: dayNames[(dayOfWeek + 2) % 7], adj: dayAfterAdj, offset: 2 },
  ];
  const bestDay = upcoming.reduce((a, b) => a.adj < b.adj ? a : b);

  const retailPrice = aaaData?.current || aaaData?.national;
  const yesterdayPrice = aaaData?.yesterday;
  const weekAgoPrice = aaaData?.weekAgo;
  const retailChange = retailPrice && yesterdayPrice ? retailPrice - yesterdayPrice : null;
  const retailWeekChange = retailPrice && weekAgoPrice ? retailPrice - weekAgoPrice : null;

  let signal, reason, savings;
  const direction = spotTrend?.direction || 'stable';

  if (direction === 'rising' && todayAdj <= tomorrowAdj) {
    signal = 'FILL_UP';
    const pctStr = spotTrend ? `(wholesale up ${spotTrend.weekChangePct.toFixed(1)}% this week)` : '';
    reason = `Wholesale spot prices are trending up ${pctStr} — retail will follow in a few days. Today is cheaper than tomorrow.`;
    savings = Math.abs(todayAdj - Math.max(tomorrowAdj, dayAfterAdj)) / 100 * 15;
  } else if (direction === 'falling' && bestDay.offset > 0) {
    signal = 'WAIT';
    reason = `Wholesale prices are dropping — retail should follow soon. ${bestDay.day} is typically cheaper.`;
    savings = Math.abs(todayAdj - bestDay.adj) / 100 * 15;
  } else if (todayAdj <= -3) {
    signal = 'FILL_UP';
    reason = `${dayNames[dayOfWeek]} is typically one of the cheapest days to fill up.`;
    savings = Math.abs(todayAdj - 5) / 100 * 15;
  } else if (todayAdj >= 4) {
    signal = 'WAIT';
    reason = `${dayNames[dayOfWeek]} is typically expensive. Wait until ${bestDay.day}.`;
    savings = Math.abs(todayAdj - bestDay.adj) / 100 * 15;
  } else if (direction === 'rising') {
    signal = 'FILL_UP';
    reason = `Wholesale prices are climbing — fill up before retail catches up.`;
    savings = spotTrend ? Math.abs(spotTrend.weekChange) * 15 : 0.5;
  } else {
    signal = 'WAIT';
    reason = `Prices are stable or falling. No rush to fill up.`;
    savings = spotTrend ? Math.abs(spotTrend.weekChange) * 15 : 0.5;
  }

  return {
    signal,
    reason,
    retailPrice,
    retailChange,
    retailWeekChange,
    yesterdayPrice,
    weekAgoPrice,
    monthAgoPrice: aaaData?.monthAgo || null,
    yearAgoPrice: aaaData?.yearAgo || null,
    spotDirection: direction,
    spotLatest: spotTrend?.latest || null,
    spotWeekChange: spotTrend?.weekChange || null,
    spotWeekChangePct: spotTrend?.weekChangePct || null,
    savings: Math.max(savings, 0.5).toFixed(2),
    bestDay: bestDay.day,
  };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatSignal(analysis, regionName) {
  if (!analysis) return "Couldn't get price data. Try again later.";

  const emoji = analysis.signal === 'FILL_UP' ? '⛽' : '⏳';
  const action = analysis.signal === 'FILL_UP' ? 'Fill up today.' : 'Wait if you can.';

  let priceInfo = '';
  if (analysis.retailPrice) {
    priceInfo = `💰 ${regionName}: $${analysis.retailPrice.toFixed(3)}/gal`;
    if (analysis.retailWeekChange != null) {
      const arrow = analysis.retailWeekChange > 0 ? '📈' : analysis.retailWeekChange < 0 ? '📉' : '➡️';
      const changeStr = analysis.retailWeekChange > 0
        ? `+${(analysis.retailWeekChange * 100).toFixed(0)}¢`
        : `${(analysis.retailWeekChange * 100).toFixed(0)}¢`;
      priceInfo += ` ${arrow} ${changeStr} from last week`;
    }
  }

  let spotInfo = '';
  if (analysis.spotDirection) {
    spotInfo = `\n🔮 Wholesale trend: ${analysis.spotDirection}`;
    if (analysis.spotWeekChangePct != null) {
      spotInfo += ` (${analysis.spotWeekChangePct > 0 ? '+' : ''}${analysis.spotWeekChangePct.toFixed(1)}%/wk)`;
    }
  }

  const tailLine = analysis.signal === 'WAIT'
    ? `Best day coming up: ${analysis.bestDay}`
    : `Potential savings vs waiting: ~$${analysis.savings}`;

  return `${emoji} ${action}\n\n${priceInfo}${spotInfo}\n\n${analysis.reason}\n\n${tailLine}`;
}

function formatTelegramPrice(aaaData, stateData, regionName, regionKey) {
  let reply = `💰 ${regionName} Gas Prices\n\n`;

  // Show state-specific price if available
  const statePrice = regionKey !== 'us' && stateData
    ? stateData.regular
    : aaaData?.current || aaaData?.national;

  if (statePrice) {
    reply += `  Regular: $${statePrice.toFixed(3)}/gal\n`;
  }

  if (aaaData) {
    if (aaaData.yesterday) reply += `  Yesterday: $${aaaData.yesterday.toFixed(3)}/gal\n`;
    if (aaaData.weekAgo) reply += `  Week ago: $${aaaData.weekAgo.toFixed(3)}/gal\n`;
    if (aaaData.monthAgo) reply += `  Month ago: $${aaaData.monthAgo.toFixed(3)}/gal\n`;
    if (aaaData.yearAgo) reply += `  Year ago: $${aaaData.yearAgo.toFixed(3)}/gal\n`;

    if (aaaData.current && aaaData.weekAgo) {
      const change = ((aaaData.current - aaaData.weekAgo) / aaaData.weekAgo * 100).toFixed(1);
      reply += `\nWeek change: ${change > 0 ? '+' : ''}${change}%`;
    }
    if (aaaData.current && aaaData.monthAgo) {
      const change = ((aaaData.current - aaaData.monthAgo) / aaaData.monthAgo * 100).toFixed(1);
      reply += `\nMonth change: ${change > 0 ? '+' : ''}${change}%`;
    }
  }

  return reply;
}

// ─── Telegram Bot ───────────────────────────────────────────────────────────

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

I analyze wholesale spot prices to predict where gas is headed, and show you today's actual retail price from AAA.

Commands:
/check — Get today's signal (fill or wait)
/region <state> — Set your state (e.g. california, tx, ny)
/subscribe — Daily signal at 7am
/unsubscribe — Stop daily signals
/price — Current price + trend
/regions — List all states

Default: U.S. Average`;

    await env.KV.put(`user:${chatId}:region`, 'us');

  } else if (text === '/check' || text === 'check') {
    const regionKey = await env.KV.get(`user:${chatId}:region`) || 'us';
    const state = STATES[regionKey] || STATES['us'];

    // Get cached data or fetch live
    let cachedSignal = JSON.parse(await env.KV.get('cached-signal') || 'null');

    if (!cachedSignal) {
      const [aaaData, spotPrices] = await Promise.all([
        scrapeAAANational(),
        fetchSpotPrices(14, env.EIA_KEY),
      ]);
      const spotTrend = analyzeSpotTrend(spotPrices);
      cachedSignal = generateSignal(aaaData, spotTrend, new Date().getDay());
    }

    // If user has a state, try to get state-specific price
    if (regionKey !== 'us' && state.aaaName) {
      const stateData = JSON.parse(await env.KV.get('aaa-states') || 'null');
      if (stateData && stateData[state.aaaName]) {
        cachedSignal.retailPrice = stateData[state.aaaName].regular;
      }
    }

    reply = formatSignal(cachedSignal, state.name);

  } else if (text === '/regions') {
    const popular = ['us', 'california', 'texas', 'florida', 'new york', 'ohio', 'illinois', 'georgia',
      'colorado', 'arizona', 'washington', 'oregon', 'michigan', 'virginia', 'dc'];
    reply = '📍 Popular states:\n\n' +
      popular.map(k => `  ${k} → ${STATES[k].name}`).join('\n') +
      '\n\nAll 50 states supported! Use 2-letter codes too (ca, tx, ny, etc.)' +
      '\n\nUse: /region <state>';

  } else if (text.startsWith('/region')) {
    const parts = text.split(/\s+/);
    const input = parts.slice(1).join(' ').toLowerCase();

    if (!input) {
      const currentKey = await env.KV.get(`user:${chatId}:region`) || 'us';
      const state = STATES[currentKey] || STATES['us'];
      reply = `Current region: ${state.name}\n\nUse /region <state> to change. See /regions for options.`;
    } else {
      // Resolve alias or direct match
      const regionKey = STATE_ALIASES[input] || (STATES[input] ? input : null);
      if (regionKey && STATES[regionKey]) {
        await env.KV.put(`user:${chatId}:region`, regionKey);
        reply = `✅ Region set to ${STATES[regionKey].name}. Use /check for today's signal.`;
      } else {
        reply = `Unknown state "${input}". Use /regions to see options, or try a 2-letter code.`;
      }
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
    const state = STATES[regionKey] || STATES['us'];

    const aaaData = JSON.parse(await env.KV.get('aaa-national') || 'null') || await scrapeAAANational();
    const stateData = JSON.parse(await env.KV.get('aaa-states') || 'null');
    const stateInfo = state.aaaName && stateData ? stateData[state.aaaName] : null;

    reply = formatTelegramPrice(aaaData, stateInfo, state.name, regionKey);

  } else {
    reply = 'Use /check for today\'s signal or /start for help.';
  }

  // Send reply
  try {
    const sendResp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply }),
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

// ─── HTTP Routes ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Telegram webhook
    if (url.pathname === '/webhook') {
      return handleTelegram(request, env);
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', bot: 'Gas Oracle', sources: ['AAA', 'EIA'] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Stats endpoint
    if (url.pathname === '/api/stats') {
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

    // History endpoint
    if (url.pathname === '/history') {
      const numDays = parseInt(url.searchParams.get('days') || '30');
      const history = [];
      for (let i = 0; i < numDays; i++) {
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
      const regionInput = (url.searchParams.get('region') || 'us').toLowerCase();
      const regionKey = STATE_ALIASES[regionInput] || regionInput;
      const state = STATES[regionKey] || STATES['us'];

      // Try cached signal first
      let analysis = JSON.parse(await env.KV.get('cached-signal') || 'null');

      if (!analysis) {
        const [aaaData, spotPrices] = await Promise.all([
          scrapeAAANational(),
          fetchSpotPrices(14, env.EIA_KEY),
        ]);
        const spotTrend = analyzeSpotTrend(spotPrices);
        analysis = generateSignal(aaaData, spotTrend, new Date().getDay());
      }

      // Override with state price if applicable
      if (regionKey !== 'us' && state.aaaName) {
        const stateData = JSON.parse(await env.KV.get('aaa-states') || 'null');
        if (stateData && stateData[state.aaaName]) {
          analysis.retailPrice = stateData[state.aaaName].regular;
        }
      }

      return new Response(JSON.stringify({ region: state.name, ...analysis }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // OG image
    if (url.pathname === '/og-image') {
      const ogImg = await env.KV.get('og-image', { type: 'arrayBuffer' });
      if (ogImg) {
        return new Response(ogImg, {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
        });
      }
      return new Response('No OG image yet', { status: 404 });
    }

    // Landing page
    if (url.pathname === '/') {
      let analysis = JSON.parse(await env.KV.get('cached-signal') || 'null');

      // Fallback: fetch live
      if (!analysis) {
        const [aaaData, spotPrices] = await Promise.all([
          scrapeAAANational(),
          fetchSpotPrices(14, env.EIA_KEY),
        ]);
        const spotTrend = analyzeSpotTrend(spotPrices);
        analysis = generateSignal(aaaData, spotTrend, new Date().getDay());
      }

      const isFillUp = analysis?.signal === 'FILL_UP';
      const signalText = isFillUp ? 'Fill Up Today' : "Wait — Don't Buy Gas Yet";
      const priceStr = analysis?.retailPrice ? `$${analysis.retailPrice.toFixed(2)}/gal` : '';
      const weekChangeStr = analysis?.retailWeekChange != null
        ? (analysis.retailWeekChange > 0
          ? `up ${(analysis.retailWeekChange * 100).toFixed(0)}¢`
          : `down ${Math.abs(analysis.retailWeekChange * 100).toFixed(0)}¢`)
        : '';
      const spotDirStr = analysis?.spotDirection || '';

      const ogTitle = `⛽ ${signalText}${priceStr ? ` | ${priceStr}` : ''}${weekChangeStr ? ` (${weekChangeStr})` : ''} — Gas Oracle`;
      const ogDescription = analysis?.retailPrice
        ? `U.S. Average: ${priceStr}${weekChangeStr ? ` (${weekChangeStr} this week)` : ''}. Wholesale trend: ${spotDirStr}. ${analysis.reason}`
        : 'Should you fill up today? Free daily gas price signals.';
      const themeColor = isFillUp ? '#22c55e' : '#ef4444';

      // Spot trend arrow for display
      const spotArrow = analysis?.spotDirection === 'rising' ? '📈' : analysis?.spotDirection === 'falling' ? '📉' : '➡️';
      const retailArrow = analysis?.retailWeekChange > 0 ? '📈' : analysis?.retailWeekChange < 0 ? '📉' : '➡️';

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
    .spot-trend { font-size: 0.95rem; color: #999; margin-bottom: 8px; }
    .reason { color: #888; font-size: 0.95rem; line-height: 1.5; }
    .source { font-size: 0.75rem; color: #555; margin-top: 12px; }
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
      ${analysis?.retailPrice ? `<div class="price">U.S. Average: $${analysis.retailPrice.toFixed(3)}/gal ${retailArrow} ${analysis.retailWeekChange != null ? (analysis.retailWeekChange > 0 ? '+' : '') + (analysis.retailWeekChange * 100).toFixed(0) + '¢/wk' : ''}</div>` : ''}
      ${analysis?.spotDirection ? `<div class="spot-trend">🔮 Wholesale trend: ${analysis.spotDirection} ${spotArrow}${analysis.spotWeekChangePct != null ? ' (' + (analysis.spotWeekChangePct > 0 ? '+' : '') + analysis.spotWeekChangePct.toFixed(1) + '%/wk)' : ''}</div>` : ''}
      <div class="reason">${analysis?.reason || ''}</div>
      <div class="source">Retail price: AAA · Signal: EIA spot prices</div>
    </div>

    <a class="cta" href="https://t.me/GasOracle2_bot">Get daily signals on Telegram →</a>

    <p style="margin-top:24px;"><a href="#" onclick="document.getElementById('shareBox').style.display='block';this.style.display='none';return false;" style="color:#555;font-size:0.85rem;">📋 Copy post for Facebook/Reddit</a></p>
    <div class="share" id="shareBox" style="display:none;">
      <div class="share-label">📋 Ready-to-post (Facebook, Reddit, etc.)</div>
      <textarea class="share-title" id="shareTitle" readonly>${isFillUp ? 'FILL UP TODAY -- gas is still climbing' : 'HOLD OFF ON GAS -- prices are dropping'}</textarea>
      <button class="copy-btn" onclick="copyText('shareTitle', this)">Copy title</button>
      <textarea class="share-body" id="shareBody" readonly>${isFillUp
        ? `U.S. average just hit ${priceStr}${weekChangeStr ? ', ' + weekChangeStr + ' from last week' : ''} and wholesale prices are still trending upward. If your tank is getting low, today is a better day to fill up than waiting. Historically, Monday and Tuesday tend to be the cheapest days of the week to buy gas, while Thursday and Friday are the most expensive because of weekend travel demand. Wholesale spot prices are a leading indicator — when they rise, retail follows in a few days. Do not get caught filling up at the peak.`
        : `U.S. average is at ${priceStr}${weekChangeStr ? ', ' + weekChangeStr + ' from last week' : ''} and wholesale prices are still falling. If you can hold off on filling up, prices should keep dropping. Historically, Monday and Tuesday tend to be the cheapest days of the week to buy gas. Wholesale spot prices lead retail by a few days, and the trend suggests waiting could save you more at the pump.`
      }</textarea>
      <button class="copy-btn" onclick="copyText('shareBody', this)">Copy body</button>
      <button class="copy-btn" onclick="copyText('shareTitle', this); copyText('shareBody', this)">Copy both</button>
    </div>

    <p class="footer">Free. No app. Just a daily signal telling you when to buy gas.<br>Retail prices from AAA · Predictions from EIA wholesale data.${analysis?.lastUpdated ? '<br>Last updated: ' + analysis.lastUpdated.replace('T', ' ').slice(0, 16) + ' UTC' : ''}</p>
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

  // Hourly cron: refresh cached data from both sources
  async scheduled(event, env, ctx) {
    // Fetch both sources in parallel
    const [aaaData, aaaStates, spotPrices] = await Promise.all([
      scrapeAAANational().catch(e => { console.error('AAA national scrape failed:', e.message); return null; }),
      scrapeAAAStates().catch(e => { console.error('AAA states scrape failed:', e.message); return null; }),
      fetchSpotPrices(14, env.EIA_KEY).catch(e => { console.error('EIA spot fetch failed:', e.message); return null; }),
    ]);

    // Cache AAA data
    if (aaaData?.current || aaaData?.national) {
      await env.KV.put('aaa-national', JSON.stringify(aaaData), { expirationTtl: 7200 });
    }
    if (aaaStates && Object.keys(aaaStates).length > 0) {
      await env.KV.put('aaa-states', JSON.stringify(aaaStates), { expirationTtl: 7200 });
    }

    // Generate signal
    const spotTrend = analyzeSpotTrend(spotPrices);
    const analysis = generateSignal(aaaData, spotTrend, new Date().getDay());

    if (analysis) {
      analysis.lastUpdated = new Date().toISOString();
      await env.KV.put('cached-signal', JSON.stringify(analysis), { expirationTtl: 7200 });

      // Save historical data daily
      const today = new Date().toISOString().slice(0, 10);
      const historyKey = `history:${today}`;
      const existing = await env.KV.get(historyKey);
      if (!existing) {
        const historyEntry = {
          date: today,
          timestamp: new Date().toISOString(),
          us: {
            retailPrice: analysis.retailPrice,
            signal: analysis.signal,
            spotDirection: analysis.spotDirection,
            spotLatest: analysis.spotLatest,
            retailWeekChange: analysis.retailWeekChange,
          },
          states: aaaStates || {},
        };
        await env.KV.put(historyKey, JSON.stringify(historyEntry));
      }

      console.log(`Cached signal: ${analysis.signal} | Retail: $${analysis.retailPrice?.toFixed(3)}/gal | Spot trend: ${analysis.spotDirection}`);
    }
  },
};
