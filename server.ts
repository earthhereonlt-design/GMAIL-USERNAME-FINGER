import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
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

interface SearchSession {
  active: boolean;
  availableCount: number;
  unavailableCount: number;
  statusMessageId?: number;
  intervalId?: NodeJS.Timeout;
}
const sessions = new Map<number, SearchSession>();
const checkedCache = new Map<string, boolean>();

async function sendTempLog(chatId: number, text: string) {
  if (!bot) return;
  try {
    const msg = await bot.sendMessage(chatId, `📝 Log: ${text}`);
    setTimeout(() => {
      bot?.deleteMessage(chatId, msg.message_id).catch(() => {});
    }, 60000);
  } catch (err) {
    console.error('Failed to send temp log:', err);
  }
}

async function generateUsernames(apiKey: string): Promise<string[]> {
  try {
    const keyToUse = apiKey || process.env.OPENROUTER_API_KEY;
    if (!keyToUse) throw new Error("OpenRouter API key is missing.");
    
    const openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: keyToUse,
    });

    const prompt = `
      Generate exactly 50 unique Gmail username ideas.
      The user wants usernames that combine a theme word (Nature, Tech, or Anime/Pokémon) with a programming language extension or tech term.
      
      Examples: earth.js, byte.go, pika.rs, ocean.cpp, naruto.ts
      
      Rules:
      - Generate NEW combinations.
      - 6 to 15 characters long.
      - ONLY lowercase letters, numbers, and dots.
      - Return ONLY a JSON array of strings. No markdown formatting, just the raw JSON array like ["name1", "name2"].
    `;

    const completion = await openai.chat.completions.create({
      model: "stepfun/step-3.5-flash:free",
      messages: [{ role: "user", content: prompt }],
    });

    const text = completion.choices[0]?.message?.content;
    if (!text) return [];
    
    const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const usernames = JSON.parse(cleanedText);
    return Array.isArray(usernames) ? usernames.map((u: any) => String(u).toLowerCase().replace(/[^a-z0-9.]/g, '')) : [];
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
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (sessions.get(chatId)?.active) {
      bot.sendMessage(chatId, 'Bot is already searching! Use /stop to stop.');
      return;
    }

    bot.sendMessage(chatId, '🔍 Starting search for available usernames...\nI will only send you the available ones.\nUse /stop to stop the search.');
    const statusMsg = await bot.sendMessage(chatId, '📊 Status: Starting...\n✅ Available found: 0\n❌ Unavailable checked: 0');

    const session: SearchSession = {
      active: true,
      availableCount: 0,
      unavailableCount: 0,
      statusMessageId: statusMsg.message_id,
    };

    session.intervalId = setInterval(() => {
      if (!session.active) return;
      const text = `📊 Status: Running 🟢\n✅ Available found: ${session.availableCount}\n❌ Unavailable checked: ${session.unavailableCount}`;
      bot.editMessageText(text, { chat_id: chatId, message_id: session.statusMessageId }).catch(() => {});
    }, 10000);

    sessions.set(chatId, session);

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      });

      while (sessions.get(chatId)?.active) {
        try {
          sendTempLog(chatId, 'Connecting to OpenRouter API to generate usernames...');
          const usernames = await generateUsernames(process.env.OPENROUTER_API_KEY || '');
          if (!usernames.length) {
            sendTempLog(chatId, 'No usernames generated, retrying in 5s...');
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }

          const toCheck = usernames.filter(u => !checkedCache.has(u));
          sendTempLog(chatId, `Generated ${usernames.length} usernames. Checking ${toCheck.length} new ones...`);
          
          const batchSize = 5; // Reduced to 5 for stability in background
          for (let i = 0; i < toCheck.length; i += batchSize) {
            if (!sessions.get(chatId)?.active) break;
            
            const batch = toCheck.slice(i, i + batchSize);
            const promises = batch.map(async (username) => {
              try {
                const available = await checkUsernameAvailability(username, browser);
                const currentSession = sessions.get(chatId);
                if (!currentSession || !currentSession.active) return;

                if (available) {
                  currentSession.availableCount++;
                  bot.sendMessage(chatId, `✅ Available: ${username}@gmail.com`);
                } else {
                  currentSession.unavailableCount++;
                }
              } catch (err) {
                console.error(`Unexpected error checking ${username}:`, err);
              }
            });

            await Promise.all(promises);
          }
          
          if (sessions.get(chatId)?.active) {
            await new Promise(r => setTimeout(r, 5000)); // Pause between cycles
          }
        } catch (error: any) {
          console.error('Loop error:', error);
          const errorMessage = error?.message || String(error);
          if (errorMessage.includes('429') || errorMessage.includes('Quota')) {
            sendTempLog(chatId, '⚠️ OpenRouter API rate limit exceeded. Waiting 60 seconds before retrying...');
            await new Promise(r => setTimeout(r, 60000));
          } else {
            sendTempLog(chatId, `⚠️ Error occurred: ${errorMessage.substring(0, 50)}... Retrying in 5s.`);
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }
    } catch (error) {
      console.error('Fatal error:', error);
      bot.sendMessage(chatId, '❌ A fatal error occurred. Search stopped.');
      const session = sessions.get(chatId);
      if (session) {
        session.active = false;
        if (session.intervalId) clearInterval(session.intervalId);
        sessions.delete(chatId);
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    const session = sessions.get(chatId);
    if (session && session.active) {
      session.active = false;
      if (session.intervalId) clearInterval(session.intervalId);
      
      if (session.statusMessageId) {
        const text = `📊 Status: Stopped 🔴\n✅ Available found: ${session.availableCount}\n❌ Unavailable checked: ${session.unavailableCount}`;
        bot.editMessageText(text, { chat_id: chatId, message_id: session.statusMessageId }).catch(() => {});
      }
      
      sessions.delete(chatId);
      bot.sendMessage(chatId, '🛑 Search stopped.');
    } else {
      bot.sendMessage(chatId, 'No active search to stop.');
    }
  });
  
  console.log('Telegram bot is ready and listening for commands.');
}
