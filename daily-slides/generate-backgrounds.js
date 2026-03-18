#!/usr/bin/env node
/**
 * Generate 4 reusable background images for Gas Oracle slides.
 * Uses OpenAI gpt-image-1 to create dark, moody gas station visuals.
 * Run once — backgrounds are reused daily.
 */

const fs = require('fs');
const path = require('path');

const BACKGROUNDS_DIR = path.join(__dirname, 'backgrounds');

// Read OpenAI key from auth profiles
const authPath = path.join(process.env.HOME, '.clawdbot/agents/main/agent/auth-profiles.json');
const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
const OPENAI_KEY = auth.profiles?.['openai:default']?.token || auth['openai:default']?.apiKey;
if (!OPENAI_KEY) { console.error('No OpenAI API key found'); process.exit(1); }

// Two sets: green (fill up) and red (wait)
const promptSets = {
  green: [
    "iPhone photo of a gas station at dawn, bright green neon signs, green-tinted lighting, wet pavement reflecting green lights, fresh optimistic morning feel, no people, no text, portrait orientation, green color palette dominant",
    "iPhone photo looking at a row of gas pumps under bright green fluorescent lights, green tinted atmosphere, clean and inviting feel, shallow depth of field, no people, no text, portrait orientation, green color tone throughout",
    "iPhone photo of a highway at sunrise with green traffic lights and green-lit road signs, fresh morning light with green tones, slight motion blur on cars, no text, portrait orientation, green atmosphere",
    "iPhone photo of a hand holding a smartphone with a glowing green screen in a dark room, green light illuminating the hand, shallow depth of field, tech vibe, no readable text on screen, portrait orientation, green ambient glow",
  ],
  red: [
    "iPhone photo of a gas station at dusk, red and amber warning lights, red-tinted neon signs, wet pavement reflecting red lights, ominous cautionary feel, no people, no text, portrait orientation, red color palette dominant",
    "iPhone photo looking at a row of gas pumps under harsh red-tinted overhead lights, red warning atmosphere, foreboding feel, shallow depth of field, no people, no text, portrait orientation, red color tone throughout",
    "iPhone photo of a highway at night with red brake lights everywhere, traffic congestion, red-tinted sky from city lights, ominous mood, no text, portrait orientation, red atmosphere",
    "iPhone photo of a hand holding a smartphone with a glowing red screen in a dark room, red light illuminating the hand, shallow depth of field, cautionary vibe, no readable text on screen, portrait orientation, red ambient glow",
  ],
};

async function generateImage(prompt, outputPath) {
  console.log(`Generating: ${path.basename(outputPath)}...`);
  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      n: 1,
      size: '1024x1536',
      quality: 'medium',
    }),
  });

  const data = await resp.json();
  if (data.error) {
    console.error('API error:', data.error.message);
    return false;
  }

  // gpt-image-1 returns b64_json
  const b64 = data.data?.[0]?.b64_json;
  if (b64) {
    fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));
    console.log(`  ✅ Saved ${outputPath}`);
    return true;
  }

  // fallback: URL
  const url = data.data?.[0]?.url;
  if (url) {
    const imgResp = await fetch(url);
    const buf = Buffer.from(await imgResp.arrayBuffer());
    fs.writeFileSync(outputPath, buf);
    console.log(`  ✅ Saved ${outputPath}`);
    return true;
  }

  console.error('No image data in response:', JSON.stringify(data).slice(0, 200));
  return false;
}

async function main() {
  for (const color of ['green', 'red']) {
    const dir = path.join(BACKGROUNDS_DIR, color);
    fs.mkdirSync(dir, { recursive: true });

    const prompts = promptSets[color];
    for (let i = 0; i < prompts.length; i++) {
      const outPath = path.join(dir, `bg${i + 1}.png`);
      if (fs.existsSync(outPath)) {
        console.log(`Skipping ${color}/bg${i + 1}.png (already exists)`);
        continue;
      }
      await generateImage(prompts[i], outPath);
    }
  }

  console.log('\nDone! Backgrounds ready in:', BACKGROUNDS_DIR);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
