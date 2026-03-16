import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { GoogleGenAI } from '@google/genai';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';

dotenv.config();
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// Dummy endpoint for Render Web Service health check
app.get('/', (req, res) => {
  res.send('Telegram Bot is running!');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web server running on port ${PORT}`);
});

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is missing. Please set it in your environment variables.');
}

const bot = token ? new TelegramBot(token, { polling: true }) : null;
const activeSearches = new Set<number>();
const checkedCache = new Map<string, boolean>();

async function generateUsernames(apiKey: string): Promise<string[]> {
  try {
    const keyToUse = apiKey || process.env.GEMINI_API_KEY;
    if (!keyToUse) throw new Error("API key is missing.");
    
    const ai = new GoogleGenAI({ apiKey: keyToUse });
    const prompt = `
      Generate exactly 50 unique Gmail username ideas.
      The user wants usernames that combine a theme word (Nature, Tech, or Anime/Pokémon) with a programming language extension or tech term.
      
      Examples: earth.js, byte.go, pika.rs, ocean.cpp, naruto.ts
      
      Rules:
      - Generate NEW combinations.
      - 6 to 15 characters long.
      - ONLY lowercase letters, numbers, and dots.
      - Return ONLY a JSON array of strings. No markdown.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });

    const text = response.text;
    if (!text) return [];
    const usernames = JSON.parse(text);
    return Array.isArray(usernames) ? usernames.map(u => u.toLowerCase().replace(/[^a-z0-9.]/g, '')) : [];
  } catch (error) {
    console.error('Error generating usernames:', error);
    throw error;
  }
}

async function checkUsernameAvailability(username: string, browser: any): Promise<boolean> {
  if (checkedCache.has(username)) return checkedCache.get(username)!;

  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle2', timeout: 20000 });
    
    const emailSelector = 'input[type="email"], input[name="identifier"], #identifierId';
    await page.waitForSelector(emailSelector, { timeout: 10000 });
    await page.type(emailSelector, username, { delay: 50 });
    await page.keyboard.press('Enter');

    const result = await Promise.race([
      page.waitForSelector('input[type="password"], input[name="Passwd"]', { timeout: 8000 }).then(() => 'taken'),
      page.waitForFunction(() => {
        const elements = document.querySelectorAll('*');
        for (const el of elements) {
          if (el.textContent?.includes("Couldn't find your Google Account") || el.textContent?.includes("Enter a valid email or phone number")) {
            return true;
          }
        }
        return false;
      }, { timeout: 8000 }).then(() => 'available'),
      new Promise(resolve => setTimeout(() => resolve('unknown'), 8500))
    ]);

    const isAvailable = result === 'available';
    if (result !== 'unknown') checkedCache.set(username, isAvailable);
    return isAvailable;
  } catch (error) {
    console.error(`Error checking ${username}:`, error);
    return false;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

if (bot) {
  bot.onText(/\/ig/, async (msg) => {
    const chatId = msg.chat.id;
    if (activeSearches.has(chatId)) {
      bot.sendMessage(chatId, 'Bot is already searching! Use /stop to stop.');
      return;
    }

    activeSearches.add(chatId);
    bot.sendMessage(chatId, '🔍 Starting search for available usernames...\nI will only send you the available ones.\nUse /stop to stop the search.');

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      });

      while (activeSearches.has(chatId)) {
        try {
          const usernames = await generateUsernames(process.env.GEMINI_API_KEY || '');
          if (!usernames.length) {
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }

          const toCheck = usernames.filter(u => !checkedCache.has(u));
          
          const batchSize = 5; // Reduced to 5 for stability in background
          for (let i = 0; i < toCheck.length; i += batchSize) {
            if (!activeSearches.has(chatId)) break;
            
            const batch = toCheck.slice(i, i + batchSize);
            const promises = batch.map(async (username) => {
              try {
                const available = await checkUsernameAvailability(username, browser);
                if (available && activeSearches.has(chatId)) {
                  bot.sendMessage(chatId, `✅ Available: ${username}@gmail.com`);
                }
              } catch (err) {
                console.error(`Unexpected error checking ${username}:`, err);
              }
            });

            await Promise.all(promises);
          }
          
          if (activeSearches.has(chatId)) {
            await new Promise(r => setTimeout(r, 5000)); // Pause between cycles
          }
        } catch (error: any) {
          console.error('Loop error:', error);
          const errorMessage = error?.message || String(error);
          if (errorMessage.includes('429') || errorMessage.includes('Quota')) {
            bot.sendMessage(chatId, '⚠️ Gemini API rate limit exceeded. Waiting 60 seconds before retrying...');
            await new Promise(r => setTimeout(r, 60000));
          } else {
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }
    } catch (error) {
      console.error('Fatal error:', error);
      bot.sendMessage(chatId, '❌ A fatal error occurred. Search stopped.');
      activeSearches.delete(chatId);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (activeSearches.has(chatId)) {
      activeSearches.delete(chatId);
      bot.sendMessage(chatId, '🛑 Search stopped.');
    } else {
      bot.sendMessage(chatId, 'No active search to stop.');
    }
  });
  
  console.log('Telegram bot is ready and listening for commands.');
}
