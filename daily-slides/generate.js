#!/usr/bin/env node
/**
 * Gas Oracle Daily TikTok Slides
 * Generates 4 slides with live gas data, delivers via Telegram.
 *
 * Slide 1: Date + Signal (FILL UP TODAY / DON'T BUY GAS YET)
 * Slide 2: Price + weekly change
 * Slide 3: Regional prices ("Your city might be different")
 * Slide 4: CTA — @GasOracle2_bot
 */

const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://gas-oracle.wrentheai.workers.dev/api/check';
const BACKGROUNDS_DIR = path.join(__dirname, 'backgrounds');
const OUTPUT_DIR = path.join(__dirname, 'output');

const TELEGRAM_BOT_TOKEN = '8535952153:AAHEEm51RrQerguQM5Xza2wwsvF7Db5D4-g';
const TELEGRAM_CHAT_ID = '7257393445'; // Kevin's DM

// Regions to show on slide 3
const REGIONS = ['la', 'houston', 'nyc', 'chicago', 'miami'];

async function fetchSignal(region = 'us') {
  const resp = await fetch(`${API_BASE}?region=${region}`);
  return resp.json();
}

async function fetchRegionalPrices() {
  const results = [];
  for (const r of REGIONS) {
    try {
      const data = await fetchSignal(r);
      if (data && data.retailPrice) {
        results.push({ region: data.region, price: data.retailPrice, change: data.retailWeekChange });
      }
    } catch (e) {
      // skip failed regions
    }
  }
  return results;
}

function formatDate() {
  const d = new Date();
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// ─── Text rendering helpers ───

function drawTextWithOutline(ctx, text, x, y, fontSize, options = {}) {
  const {
    fillColor = '#FFFFFF',
    outlineColor = '#000000',
    outlineWidth = Math.round(fontSize * 0.12),
    align = 'center',
    baseline = 'top',
    fontWeight = 'bold',
    fontFamily = 'Arial',
    maxWidth = null,
  } = options;

  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  // Outline
  ctx.strokeStyle = outlineColor;
  ctx.lineWidth = outlineWidth;
  if (maxWidth) {
    ctx.strokeText(text, x, y, maxWidth);
  } else {
    ctx.strokeText(text, x, y);
  }

  // Fill
  ctx.fillStyle = fillColor;
  if (maxWidth) {
    ctx.fillText(text, x, y, maxWidth);
  } else {
    ctx.fillText(text, x, y);
  }
}

function wrapText(ctx, text, maxWidth, fontSize) {
  ctx.font = `bold ${fontSize}px Arial`;
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ─── Slide generators ───

// Color scheme based on signal
function getColorScheme(signal) {
  const isFillUp = signal === 'FILL_UP';
  return {
    isFillUp,
    // Overlay tint
    tint: isFillUp ? 'rgba(0, 40, 0, 0.55)' : 'rgba(50, 0, 0, 0.55)',
    // Primary accent
    accent: isFillUp ? '#22c55e' : '#ef4444',
    // Secondary accent (lighter)
    accentLight: isFillUp ? '#4ade80' : '#f87171',
    // Signal text
    signalText: isFillUp ? 'FILL UP TODAY' : "DON'T BUY GAS YET",
    // Price change color (up = red/bad for wallet, down = green/good)
    priceUp: '#ef4444',
    priceDown: '#22c55e',
  };
}

async function generateSlide1(usSignal, bgPath) {
  const img = await loadImage(bgPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const colors = getColorScheme(usSignal.signal);

  // Tinted overlay
  ctx.fillStyle = colors.tint;
  ctx.fillRect(0, 0, img.width, img.height);

  const centerX = img.width / 2;

  // Date
  const dateStr = formatDate();
  drawTextWithOutline(ctx, dateStr, centerX, img.height * 0.18, Math.round(img.width * 0.055), {
    fillColor: '#EEEEEE',
  });

  // Signal - big, white, bold
  const signalSize = Math.round(img.width * 0.11);
  const lines = wrapText(ctx, colors.signalText, img.width * 0.85, signalSize);
  const lineHeight = signalSize * 1.25;
  const startY = img.height * 0.32 - (lines.length * lineHeight) / 2;

  for (let i = 0; i < lines.length; i++) {
    drawTextWithOutline(ctx, lines[i], centerX, startY + i * lineHeight, signalSize, {
      fillColor: '#FFFFFF',
    });
  }

  // Sub-reason (moved up from 0.68)
  const reasonSize = Math.round(img.width * 0.045);
  const reasonLines = wrapText(ctx, usSignal.reason, img.width * 0.8, reasonSize);
  const reasonStartY = img.height * 0.50;
  for (let i = 0; i < reasonLines.length; i++) {
    drawTextWithOutline(ctx, reasonLines[i], centerX, reasonStartY + i * (reasonSize * 1.4), reasonSize, {
      fillColor: '#EEEEEE',
    });
  }

  return canvas;
}

async function generateSlide2(usSignal, bgPath) {
  const img = await loadImage(bgPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const colors = getColorScheme(usSignal.signal);
  ctx.fillStyle = colors.tint;
  ctx.fillRect(0, 0, img.width, img.height);

  const centerX = img.width / 2;

  // Header
  drawTextWithOutline(ctx, 'U.S. AVERAGE', centerX, img.height * 0.18, Math.round(img.width * 0.05), {
    fillColor: '#DDDDDD',
  });

  // Big price
  const priceStr = `$${usSignal.retailPrice.toFixed(2)}`;
  drawTextWithOutline(ctx, priceStr, centerX, img.height * 0.27, Math.round(img.width * 0.14), {
    fillColor: '#FFFFFF',
  });

  drawTextWithOutline(ctx, 'per gallon', centerX, img.height * 0.41, Math.round(img.width * 0.05), {
    fillColor: '#EEEEEE',
  });

  // Weekly change
  const changeDir = usSignal.retailWeekChange > 0 ? 'UP' : 'DOWN';
  const changeCents = Math.abs(usSignal.retailWeekChange * 100).toFixed(0);
  const changeColor = usSignal.retailWeekChange > 0 ? colors.priceUp : colors.priceDown;
  const arrow = usSignal.retailWeekChange > 0 ? '↑' : '↓';
  const changeText = `${arrow} ${changeCents}¢ ${changeDir} THIS WEEK`;

  drawTextWithOutline(ctx, changeText, centerX, img.height * 0.52, Math.round(img.width * 0.065), {
    fillColor: changeColor,
  });

  return canvas;
}

async function generateSlide3(regionalPrices, usSignal, bgPath) {
  const img = await loadImage(bgPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const colors = getColorScheme(usSignal.signal);
  ctx.fillStyle = colors.tint;
  ctx.fillRect(0, 0, img.width, img.height);

  const centerX = img.width / 2;

  // Header - use accent color consistently
  drawTextWithOutline(ctx, 'YOUR CITY MIGHT', centerX, img.height * 0.15, Math.round(img.width * 0.065), {
    fillColor: colors.accent,
  });
  drawTextWithOutline(ctx, 'BE DIFFERENT', centerX, img.height * 0.22, Math.round(img.width * 0.065), {
    fillColor: colors.accent,
  });

  // Regional prices list
  const itemSize = Math.round(img.width * 0.05);
  const startY = img.height * 0.34;
  const spacing = img.height * 0.09;

  for (let i = 0; i < regionalPrices.length && i < 5; i++) {
    const r = regionalPrices[i];
    const y = startY + i * spacing;
    const arrow = r.change > 0 ? '↑' : r.change < 0 ? '↓' : '→';
    const color = r.change > 0 ? colors.priceUp : r.change < 0 ? colors.priceDown : '#CCCCCC';

    // City name on left
    drawTextWithOutline(ctx, r.region, img.width * 0.15, y, itemSize, {
      align: 'left',
      fillColor: '#FFFFFF',
    });

    // Price + arrow on right
    const priceText = `$${r.price.toFixed(2)} ${arrow}`;
    drawTextWithOutline(ctx, priceText, img.width * 0.85, y, itemSize, {
      align: 'right',
      fillColor: color,
    });
  }

  return canvas;
}

async function generateSlide4(usSignal, bgPath) {
  const img = await loadImage(bgPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const colors = getColorScheme(usSignal.signal);
  ctx.fillStyle = colors.tint;
  ctx.fillRect(0, 0, img.width, img.height);

  const centerX = img.width / 2;

  // Header
  drawTextWithOutline(ctx, 'GET YOUR DAILY', centerX, img.height * 0.18, Math.round(img.width * 0.07), {
    fillColor: '#FFFFFF',
  });
  drawTextWithOutline(ctx, 'GAS SIGNAL', centerX, img.height * 0.26, Math.round(img.width * 0.07), {
    fillColor: '#FFFFFF',
  });

  // Free - in accent color
  drawTextWithOutline(ctx, 'FREE', centerX, img.height * 0.38, Math.round(img.width * 0.1), {
    fillColor: colors.accent,
  });

  // Bot name - white for readability
  drawTextWithOutline(ctx, '@GasOracle2_bot', centerX, img.height * 0.50, Math.round(img.width * 0.06), {
    fillColor: '#FFFFFF',
  });

  drawTextWithOutline(ctx, 'on Telegram', centerX, img.height * 0.58, Math.round(img.width * 0.05), {
    fillColor: '#EEEEEE',
  });

  return canvas;
}

// ─── Telegram delivery ───

async function sendPhotoToTelegram(imagePath, caption = '') {
  const form = new FormData();
  form.append('chat_id', TELEGRAM_CHAT_ID);
  form.append('photo', new Blob([fs.readFileSync(imagePath)], { type: 'image/png' }), path.basename(imagePath));
  if (caption) form.append('caption', caption);

  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  return resp.json();
}

async function sendMediaGroupToTelegram(imagePaths, caption = '') {
  const form = new FormData();
  form.append('chat_id', TELEGRAM_CHAT_ID);

  const media = imagePaths.map((p, i) => ({
    type: 'photo',
    media: `attach://photo${i}`,
    ...(i === 0 && caption ? { caption } : {}),
  }));
  form.append('media', JSON.stringify(media));

  imagePaths.forEach((p, i) => {
    form.append(`photo${i}`, new Blob([fs.readFileSync(p)], { type: 'image/png' }), `slide${i + 1}.png`);
  });

  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`, {
    method: 'POST',
    body: form,
  });
  return resp.json();
}

// ─── Main ───

async function main() {
  console.log('🔮 Gas Oracle Daily Slides Generator');
  console.log(`Date: ${formatDate()}`);

  // Ensure output dir
  const today = new Date().toISOString().slice(0, 10);
  const outputDir = path.join(OUTPUT_DIR, today);
  fs.mkdirSync(outputDir, { recursive: true });

  // Fetch data
  console.log('Fetching US signal...');
  let usSignal = await fetchSignal('us');
  
  // --mock-wait flag: simulate a WAIT signal for testing
  if (process.argv.includes('--mock-wait')) {
    usSignal = {
      ...usSignal,
      signal: 'WAIT',
      trend: 'falling',
      reason: 'Prices are dropping and Monday is typically the cheapest day. Hold off.',
      weeklyChange: -0.32,
      weeklyChangePct: -8.9,
    };
    console.log('(Using mock WAIT signal for preview)');
  }
  
  console.log(`Signal: ${usSignal.signal} | $${usSignal.retailPrice}/gal | ${usSignal.spotDirection}`);

  console.log('Fetching regional prices...');
  const regional = await fetchRegionalPrices();
  console.log(`Got ${regional.length} regions`);

  // Pick background set based on signal
  const bgColor = usSignal.signal === 'FILL_UP' ? 'green' : 'red';
  const bgDir = path.join(BACKGROUNDS_DIR, bgColor);
  const bgFiles = fs.existsSync(bgDir)
    ? fs.readdirSync(bgDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f)).sort()
    : [];

  if (bgFiles.length < 4) {
    // Fallback to root backgrounds dir
    const rootBgs = fs.readdirSync(BACKGROUNDS_DIR).filter(f => /\.(png|jpg|jpeg)$/i.test(f)).sort();
    if (rootBgs.length < 4) {
      console.error(`Need at least 4 background images in ${bgDir} or ${BACKGROUNDS_DIR}`);
      console.error('Generate them first with: node generate-backgrounds.js');
      process.exit(1);
    }
    var bgs = rootBgs.slice(0, 4).map(f => path.join(BACKGROUNDS_DIR, f));
  } else {
    var bgs = bgFiles.slice(0, 4).map(f => path.join(bgDir, f));
  }
  console.log(`Using ${bgColor} backgrounds`);

  // Generate slides
  console.log('Generating slide 1 (signal)...');
  const slide1 = await generateSlide1(usSignal, bgs[0]);
  const slide1Path = path.join(outputDir, 'slide1.png');
  fs.writeFileSync(slide1Path, slide1.toBuffer('image/png'));

  console.log('Generating slide 2 (price)...');
  const slide2 = await generateSlide2(usSignal, bgs[1]);
  const slide2Path = path.join(outputDir, 'slide2.png');
  fs.writeFileSync(slide2Path, slide2.toBuffer('image/png'));

  console.log('Generating slide 3 (regional)...');
  const slide3 = await generateSlide3(regional, usSignal, bgs[2]);
  const slide3Path = path.join(outputDir, 'slide3.png');
  fs.writeFileSync(slide3Path, slide3.toBuffer('image/png'));

  console.log('Generating slide 4 (CTA)...');
  const slide4 = await generateSlide4(usSignal, bgs[3]);
  const slide4Path = path.join(outputDir, 'slide4.png');
  fs.writeFileSync(slide4Path, slide4.toBuffer('image/png'));

  const slides = [slide1Path, slide2Path, slide3Path, slide4Path];

  // Generate OG image (1200x630) and upload to KV
  console.log('Generating OG image...');
  const ogCanvas = createCanvas(1200, 630);
  const ogCtx = ogCanvas.getContext('2d');
  
  const ogColors = getColorScheme(usSignal.signal);
  // Background
  ogCtx.fillStyle = ogColors.isFillUp ? '#064e3b' : '#7f1d1d';
  ogCtx.fillRect(0, 0, 1200, 630);
  
  // Date
  ogCtx.font = 'bold 28px Arial';
  ogCtx.fillStyle = '#999';
  ogCtx.textAlign = 'center';
  ogCtx.fillText(formatDate(), 600, 100);
  
  // Signal
  ogCtx.font = 'bold 72px Arial';
  ogCtx.fillStyle = '#FFFFFF';
  ogCtx.fillText(ogColors.signalText, 600, 210);
  
  // Price
  ogCtx.font = 'bold 64px Arial';
  ogCtx.fillStyle = '#FFFFFF';
  ogCtx.fillText(`$${usSignal.retailPrice.toFixed(2)}/gal`, 600, 310);
  
  // Change
  const ogChangeDir = usSignal.retailWeekChange > 0 ? '↑' : '↓';
  const ogChangeCents = Math.abs(usSignal.retailWeekChange * 100).toFixed(0);
  ogCtx.font = 'bold 36px Arial';
  ogCtx.fillStyle = ogColors.accent;
  ogCtx.fillText(`${ogChangeDir} ${ogChangeCents}¢ this week`, 600, 380);
  
  // Branding
  ogCtx.font = 'bold 42px Arial';
  ogCtx.fillStyle = '#FFFFFF';
  ogCtx.fillText('Gas Oracle', 600, 490);
  
  ogCtx.font = '24px Arial';
  ogCtx.fillStyle = '#888';
  ogCtx.fillText('thegasoracle.com — Free daily gas price signals', 600, 540);
  
  const ogPng = ogCanvas.toBuffer('image/png');
  const ogPath = path.join(outputDir, 'og-image.png');
  fs.writeFileSync(ogPath, ogPng);
  
  // Upload OG image to KV via wrangler
  try {
    const { execSync } = require('child_process');
    execSync(
      `wrangler kv key put og-image --path "${ogPath}" --namespace-id cec12f6be0a441cabd5e37de942e249d --remote`,
      { cwd: path.join(__dirname, '../worker'), stdio: 'pipe' }
    );
    console.log('OG image upload: ✅');
  } catch (e) {
    console.log(`OG image KV upload failed (non-critical): ${e.message}`);
  }

  // Send to Telegram
  if (process.argv.includes('--no-send')) {
    console.log('Slides generated (--no-send, skipping Telegram)');
    slides.forEach(s => console.log(`  ${s}`));
    return;
  }

  console.log('Sending to Telegram...');
  const isFillUp = usSignal.signal === 'FILL_UP';
  const caption = `⛽ Gas Oracle — ${formatDate()}\n${isFillUp ? '🟢 FILL UP TODAY' : '🟡 WAIT'} | $${usSignal.retailPrice.toFixed(2)}/gal | ${usSignal.spotDirection}`;

  const result = await sendMediaGroupToTelegram(slides, caption);
  if (result.ok) {
    console.log('✅ Delivered to Telegram!');
  } else {
    console.error('❌ Telegram send failed:', JSON.stringify(result));
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
