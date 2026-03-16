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
  lastErrorMsgId?: number;
  checksSinceRestart: number;
}
const sessions = new Map<number, SearchSession>();
const checkedCache = new Map<string, boolean>();

// Limit cache size to prevent memory leaks
function addToCache(username: string, isAvailable: boolean) {
  if (checkedCache.size > 5000) {
    const firstKey = checkedCache.keys().next().value;
    if (firstKey) checkedCache.delete(firstKey);
  }
  checkedCache.set(username, isAvailable);
}

async function updateStatusMessage(chatId: number, session: SearchSession, status: string = 'Running 🟢') {
  if (!bot || !session.active) return;
  const totalAttempts = session.availableCount + session.unavailableCount;
  const text = `📊 Status: ${status}\n🔄 Total Attempts: ${totalAttempts}\n✅ Available found: ${session.availableCount}\n❌ Unavailable checked: ${session.unavailableCount}`;
  
  try {
    // Delete old message and send a new one so it stays at the bottom
    if (session.statusMessageId) {
      await bot.deleteMessage(chatId, session.statusMessageId).catch(() => {});
    }
    const newMsg = await bot.sendMessage(chatId, text);
    session.statusMessageId = newMsg.message_id;
  } catch (err) {
    console.error('Failed to update status message:', err);
  }
}

async function sendTempLog(chatId: number, text: string, isError: boolean = false) {
  if (!bot) return;
  try {
    const session = sessions.get(chatId);
    if (isError && session && session.lastErrorMsgId) {
      await bot.deleteMessage(chatId, session.lastErrorMsgId).catch(() => {});
    }

    const msg = await bot.sendMessage(chatId, isError ? `⚠️ Error: ${text}` : `📝 Log: ${text}`);
    
    if (isError && session) {
      session.lastErrorMsgId = msg.message_id;
    }

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
    
    // Block unnecessary resources to speed up and prevent timeouts
    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    // Use domcontentloaded for faster navigation
    await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 20000 });
    
    const emailSelector = 'input[type="email"], input[name="identifier"], #identifierId';
    await page.waitForSelector(emailSelector, { timeout: 10000 });
    
    // Small random delay to simulate human typing
    await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
    await page.type(emailSelector, username, { delay: 30 });
    
    // Press Enter and try to click Next button
    await Promise.all([
      page.keyboard.press('Enter'),
      page.click('#identifierNext button').catch(() => {})
    ]);

    const result = await Promise.race([
      page.waitForSelector('input[type="password"], input[name="Passwd"]', { timeout: 10000 }).then(() => 'taken'),
      page.waitForFunction(() => {
        const text = document.body.innerText || '';
        return text.includes("Couldn't find your Google Account") || 
               text.includes("Enter a valid email or phone number") ||
               text.includes("find your Google account");
      }, { timeout: 10000 }).then(() => 'available'),
      new Promise(resolve => setTimeout(() => resolve('unknown'), 10500))
    ]);

    const isAvailable = result === 'available';
    if (result !== 'unknown') addToCache(username, isAvailable);
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

    const session: SearchSession = {
      active: true,
      availableCount: 0,
      unavailableCount: 0,
      checksSinceRestart: 0,
    };
    sessions.set(chatId, session);
    await updateStatusMessage(chatId, session, 'Starting...');

    let browser;
    const launchBrowser = async () => {
      return await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox', 
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--single-process',
          '--disable-extensions'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      });
    };

    try {
      browser = await launchBrowser();

      while (sessions.get(chatId)?.active) {
        try {
          const currentSession = sessions.get(chatId);
          if (!currentSession) break;

          // Restart browser periodically to free memory
          if (currentSession.checksSinceRestart > 40 || !browser || !browser.isConnected()) {
            sendTempLog(chatId, 'Restarting browser to free memory...');
            if (browser) await browser.close().catch(() => {});
            browser = await launchBrowser();
            currentSession.checksSinceRestart = 0;
          }

          sendTempLog(chatId, 'Connecting to OpenRouter API to generate usernames...');
          const usernames = await generateUsernames(process.env.OPENROUTER_API_KEY || '');
          if (!usernames.length) {
            sendTempLog(chatId, 'No usernames generated, retrying in 5s...');
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }

          const toCheck = usernames.filter(u => !checkedCache.has(u));
          sendTempLog(chatId, `Generated ${usernames.length} usernames. Checking ${toCheck.length} new ones...`);
          
          // Send generated usernames to user for 2 minutes
          if (usernames.length > 0) {
            bot.sendMessage(chatId, `📝 Generated Batch:\n${usernames.join(', ')}`).then(msg => {
              setTimeout(() => {
                bot?.deleteMessage(chatId, msg.message_id).catch(() => {});
              }, 120000); // 120,000 ms = 2 minutes
            }).catch(err => console.error('Failed to send generated usernames:', err));
          }
          
          const batchSize = 2; // Reduced to 2 to save memory
          for (let i = 0; i < toCheck.length; i += batchSize) {
            if (!sessions.get(chatId)?.active) break;
            
            const batch = toCheck.slice(i, i + batchSize);
            const promises = batch.map(async (username) => {
              try {
                const available = await checkUsernameAvailability(username, browser);
                const currentSession = sessions.get(chatId);
                if (!currentSession || !currentSession.active) return;

                currentSession.checksSinceRestart++;

                if (available) {
                  currentSession.availableCount++;
                  bot.sendMessage(chatId, `✅ Available: ${username}@gmail.com`).then(msg => {
                    setTimeout(() => {
                      bot?.deleteMessage(chatId, msg.message_id).catch(() => {});
                    }, 120000); // Delete after 2 minutes (120,000 ms)
                  }).catch(err => console.error('Failed to send available message:', err));
                } else {
                  currentSession.unavailableCount++;
                }
              } catch (err) {
                console.error(`Unexpected error checking ${username}:`, err);
              }
            });

            await Promise.all(promises);
            
            // Update status message after every batch
            const currentSession = sessions.get(chatId);
            if (currentSession && currentSession.active) {
              await updateStatusMessage(chatId, currentSession);
            }
          }
          
          if (sessions.get(chatId)?.active) {
            await new Promise(r => setTimeout(r, 5000)); // Pause between cycles
          }
        } catch (error: any) {
          console.error('Loop error:', error);
          const errorMessage = error?.message || String(error);
          if (errorMessage.includes('429') || errorMessage.includes('Quota')) {
            sendTempLog(chatId, 'OpenRouter API rate limit exceeded. Waiting 60 seconds before retrying...', true);
            await new Promise(r => setTimeout(r, 60000));
          } else {
            sendTempLog(chatId, `${errorMessage}\n\nRetrying in 5s...`, true);
            if (browser) {
              await browser.close().catch(() => {});
              browser = null; // Force restart on next loop
            }
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
      
      updateStatusMessage(chatId, session, 'Stopped 🔴').then(() => {
        sessions.delete(chatId);
        bot.sendMessage(chatId, '🛑 Search stopped.');
      });
    } else {
      bot.sendMessage(chatId, 'No active search to stop.');
    }
  });
  
  console.log('Telegram bot is ready and listening for commands.');
}
