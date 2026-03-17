import http from 'http';
import path from 'path';
import TelegramBot from 'node-telegram-bot-api';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import fs from 'fs';
import { logger } from './src/utils/logger.js';

dotenv.config();
puppeteer.use(StealthPlugin());

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', { promise, reason });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', { error: error.message, stack: error.stack });
});

const PORT = 3000;

// Lightweight health check server using native http
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Telegram Bot is running!');
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Web server running on port ${PORT}`);
});

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  logger.error('TELEGRAM_BOT_TOKEN is missing. Please set it in your environment variables.');
}

const bot = token ? new TelegramBot(token, { polling: true }) : null;

if (bot) {
  bot.on('polling_error', (error: any) => {
    if (error.message.includes('ETELEGRAM: 409 Conflict')) {
      // This is common during restarts/deploys as the old instance shuts down
      logger.warn('Telegram polling conflict (409). Waiting for old instance to terminate...');
    } else {
      logger.error('Telegram polling error:', { error: error.message });
    }
  });
}

// Clean shutdown logic
const shutdown = async (signal: string) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);
  
  if (bot) {
    logger.info('Stopping Telegram bot polling...');
    await bot.stopPolling();
  }

  // Save sessions before exiting
  saveSessions();

  server.close(() => {
    logger.info('HTTP server closed.');
    process.exit(0);
  });

  // Force exit after 10s if not closed
  setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

interface SearchSession {
  active: boolean;
  availableCount: number;
  unavailableCount: number;
  unknownCount: number;
  statusMessageId?: number;
  lastErrorMsgId?: number;
  checksSinceRestart: number;
  currentChecking: string[];
  apiKey?: string;
}
const sessions = new Map<number, SearchSession>();
const checkedCache = new Map<string, boolean>();
const SESSIONS_FILE = path.join(process.cwd(), 'sessions.json');

// Persistence: Save/Load sessions
function saveSessions() {
  try {
    const data = Array.from(sessions.entries()).map(([id, s]) => [id, { ...s, currentChecking: [] }]);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data));
  } catch (e) {
    logger.error('Failed to save sessions', { error: e });
  }
}

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      data.forEach(([id, s]: [number, any]) => {
        sessions.set(id, s);
      });
      logger.info(`Loaded ${sessions.size} sessions from storage`);
    }
  } catch (e) {
    logger.error('Failed to load sessions', { error: e });
  }
}

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
  const totalAttempts = session.availableCount + session.unavailableCount + session.unknownCount;
  const checkingText = session.currentChecking.length > 0 
    ? `\n🔍 *Currently checking:* \`${session.currentChecking.join(', ')}\``
    : '';

  const text = `
✨ *Gmail Checker Status* ✨
━━━━━━━━━━━━━━━━━━━━
📡 *Status:* ${status}
🔄 *Total Attempts:* \`${totalAttempts}\`
✅ *Available:* \`${session.availableCount}\`
❌ *Unavailable:* \`${session.unavailableCount}\`
⚠️ *Unknown/Blocked:* \`${session.unknownCount}\`
${checkingText}
━━━━━━━━━━━━━━━━━━━━
_Searching for your next username..._`;
  
  try {
    if (session.statusMessageId) {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: session.statusMessageId,
        parse_mode: 'Markdown'
      }).catch(async (err) => {
        // If edit fails (e.g. message deleted), send a new one
        if (err.message.includes('message to edit not found') || err.message.includes('message is not modified')) {
          const newMsg = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
          session.statusMessageId = newMsg.message_id;
        }
      });
    } else {
      const newMsg = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      session.statusMessageId = newMsg.message_id;
    }
  } catch (err) {
    logger.error('Failed to update status message', { error: err, chatId });
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
    logger.error('Failed to send temp log', { error: err, chatId, text });
  }
}

async function generateUsernames(apiKey: string): Promise<string[]> {
  try {
    const keyToUse = apiKey || process.env.OPENROUTER_API_KEY;
    if (!keyToUse) throw new Error("OpenRouter API key is missing.");
    
    const prompt = `
      Generate exactly 100 unique Gmail username ideas.
      The user wants usernames that combine a theme word (Nature, Tech, or Anime/Pokémon) with a programming language extension or tech term.
      
      Examples: earth.js, byte.go, pika.rs, ocean.cpp, naruto.ts
      
      Rules:
      - Generate NEW combinations.
      - 6 to 15 characters long.
      - ONLY lowercase letters, numbers, and dots.
      - Return ONLY a JSON array of strings. No markdown formatting, just the raw JSON array like ["name1", "name2"].
    `;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${keyToUse}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/OpenRouterTeam/openrouter-runner",
        "X-Title": "Gmail Checker Bot"
      },
      body: JSON.stringify({
        model: "stepfun/step-3.5-flash:free",
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`OpenRouter API error: ${response.status} ${JSON.stringify(errorData)}`);
    }

    const data: any = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      logger.warn('OpenRouter returned empty content');
      return [];
    }
    
    const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const usernames = JSON.parse(cleanedText);
    logger.info(`Generated ${usernames.length} usernames`);
    return Array.isArray(usernames) ? usernames.map((u: any) => String(u).toLowerCase().replace(/[^a-z0-9.]/g, '')) : [];
  } catch (error) {
    logger.error('Error generating usernames', { error });
    throw error;
  }
}

// Native lightweight concurrency helper to replace 'async' library
async function pMapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array(Math.min(limit, queue.length)).fill(null).map(async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

async function checkUsernameAvailability(username: string, browser: any): Promise<boolean> {
  if (checkedCache.has(username)) return checkedCache.get(username)!;

  let page;
  try {
    logger.debug(`Starting check for: ${username}`);
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
    
    logger.debug(`Navigating to Google sign-in for: ${username}`);
    // Use a more direct service URL which is often lighter
    await page.goto('https://accounts.google.com/AccountChooser?service=mail&continue=https://mail.google.com/mail/', { 
      waitUntil: 'networkidle2', 
      timeout: 40000 
    });
    
    const emailSelector = 'input[type="email"], input[name="identifier"], #identifierId';
    logger.debug(`Waiting for email selector for: ${username}`);
    await page.waitForSelector(emailSelector, { timeout: 20000 });
    
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
    logger.debug(`Typing username: ${username}`);
    await page.type(emailSelector, username, { delay: 10 });
    
    logger.debug(`Submitting username: ${username}`);
    await Promise.all([
      page.keyboard.press('Enter'),
      page.click('#identifierNext button').catch(() => {})
    ]);

    logger.debug(`Waiting for result for: ${username}`);
    const result = await Promise.race([
      page.waitForSelector('input[type="password"], input[name="Passwd"]', { timeout: 20000 }).then(() => 'taken'),
      page.waitForFunction(() => {
        const text = document.body.innerText || '';
        return text.includes("Couldn't find your Google Account") || 
               text.includes("Enter a valid email or phone number") ||
               text.includes("find your Google account");
      }, { timeout: 20000 }).then(() => 'available'),
      page.waitForSelector('#captcha, img[src*="captcha"], iframe[src*="recaptcha"]', { timeout: 20000 }).then(() => 'blocked'),
      page.waitForFunction(() => {
        const text = document.body.innerText || '';
        return text.includes("Verify it's you") || text.includes("unusual activity");
      }, { timeout: 20000 }).then(() => 'blocked'),
      new Promise(resolve => setTimeout(() => resolve('unknown'), 22000))
    ]);

    logger.info(`Check result for ${username}: ${result}`);
    
    if (result === 'unknown' || result === 'blocked') {
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      logger.warn(`${result === 'blocked' ? 'Blocked by Google' : 'Unknown result'} for ${username}. Page snippet: ${bodyText.replace(/\n/g, ' ')}`);
    }

    const isAvailable = result === 'available';
    // Only cache clear results
    if (result === 'available' || result === 'taken') addToCache(username, isAvailable);
    return isAvailable;
  } catch (error: any) {
    // Re-throw the error so the retry loop can handle it (e.g. browser crash)
    throw error;
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
      unknownCount: 0,
      checksSinceRestart: 0,
      currentChecking: [],
      apiKey: process.env.OPENROUTER_API_KEY || '',
    };
    sessions.set(chatId, session);
    saveSessions();
    await updateStatusMessage(chatId, session, 'Starting...');
    startSearchLoop(chatId);
  });

  bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    const session = sessions.get(chatId);
    if (session && session.active) {
      session.active = false;
      saveSessions();
      updateStatusMessage(chatId, session, 'Stopped 🔴').then(() => {
        bot.sendMessage(chatId, '🛑 Search stopped.');
      });
    } else {
      bot.sendMessage(chatId, 'No active search to stop.');
    }
  });

  bot.onText(/\/logs/, async (msg) => {
    const chatId = msg.chat.id;
    const logPath = logger.getLogFilePath();
    
    if (fs.existsSync(logPath)) {
      try {
        await bot.sendDocument(chatId, logPath, { caption: '📄 Application Logs' });
      } catch (err) {
        logger.error('Failed to send logs', { error: err, chatId });
        bot.sendMessage(chatId, '❌ Failed to send log file.');
      }
    } else {
      bot.sendMessage(chatId, '❌ Log file not found.');
    }
  });

  // Auto-resume sessions on startup
  loadSessions();
  sessions.forEach((session, chatId) => {
    if (session.active) {
      logger.info(`Resuming session for ${chatId}`);
      bot.sendMessage(chatId, '🔄 *Bot restarted:* Resuming your search automatically...', { parse_mode: 'Markdown' }).catch(() => {});
      startSearchLoop(chatId);
    }
  });
  
  logger.info('Telegram bot is ready and listening for commands.');
}

async function startSearchLoop(chatId: number) {
  logger.info(`Starting search loop for ${chatId}`);
  
  let browser: any = null;

  const launchBrowser = async () => {
    return await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-extensions',
        '--single-process',
        '--disable-canvas-aa',
        '--disable-2d-canvas-clip-aa',
        '--disable-gl-drawing-for-tests',
        '--no-first-run',
        '--js-flags="--max-old-space-size=256"'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
  };

  while (true) {
    const session = sessions.get(chatId);
    if (!session || !session.active) {
      logger.info(`Loop ending for ${chatId} (session inactive or removed)`);
      break;
    }

    const apiKey = session.apiKey || process.env.OPENROUTER_API_KEY || '';

    try {
      while (sessions.get(chatId)?.active) {
        const currentSession = sessions.get(chatId);
        if (!currentSession || !currentSession.active) break;

        await updateStatusMessage(chatId, currentSession, 'Generating Usernames... 🧠');
        
        let usernames: string[] = [];
        try {
          usernames = await generateUsernames(apiKey);
        } catch (err: any) {
          logger.error('Generation failed', { error: err.message });
          await updateStatusMessage(chatId, currentSession, 'Retrying Generation... ⏳');
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }

        if (!usernames.length) {
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }

        const toCheck = usernames.filter(u => !checkedCache.has(u));
        if (toCheck.length === 0) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const chunkSize = 3;
        for (let i = 0; i < toCheck.length; i += chunkSize) {
          if (!sessions.get(chatId)?.active) break;

          // Restart browser periodically
          if (currentSession.checksSinceRestart >= 6 || !browser || !browser.isConnected()) {
            if (browser) await browser.close().catch(() => {});
            browser = await launchBrowser();
            currentSession.checksSinceRestart = 0;
            
            try {
              const stats = fs.statSync('app.log');
              if (stats.size > 5 * 1024 * 1024) {
                fs.writeFileSync('app.log', '');
              }
            } catch (e) {}
          }

          const chunk = toCheck.slice(i, i + chunkSize);
          
          await pMapLimit(chunk, 1, async (username) => {
            const s = sessions.get(chatId);
            if (!s || !s.active) return;
            
            s.currentChecking.push(username);
            updateStatusMessage(chatId, s).catch(() => {});

            let available = false;
            let checkSuccess = false;
            
            try {
              for (let attempt = 1; attempt <= 2; attempt++) {
                if (!sessions.get(chatId)?.active) return;
                
                if (!browser || !browser.isConnected()) {
                  if (browser) await browser.close().catch(() => {});
                  browser = await launchBrowser();
                }

                try {
                  available = await Promise.race([
                    checkUsernameAvailability(username, browser),
                    new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('Check timeout')), 60000))
                  ]);
                  checkSuccess = true;
                  break;
                } catch (err: any) {
                  logger.error(`Attempt ${attempt} failed for ${username}`, { error: err.message, username });
                  if (err?.message?.includes('Target closed') || err?.message?.includes('Protocol error') || err?.message?.includes('timeout')) {
                    if (browser) await browser.close().catch(() => {});
                    browser = null;
                  }
                  if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
                }
              }
            } finally {
              const sFinal = sessions.get(chatId);
              if (sFinal) sFinal.currentChecking = sFinal.currentChecking.filter(u => u !== username);
            }
            
            const sFinal = sessions.get(chatId);
            if (!sFinal || !sFinal.active) return;

            sFinal.checksSinceRestart++;

            if (checkSuccess) {
              if (available) {
                sFinal.availableCount++;
                bot?.sendMessage(chatId, `✅ Available: ${username}@gmail.com`).then(msg => {
                  setTimeout(() => bot?.deleteMessage(chatId, msg.message_id).catch(() => {}), 120000);
                }).catch(() => {});
              } else {
                sFinal.unavailableCount++;
              }
            } else {
              sFinal.unknownCount++;
            }
          });
          
          if (sessions.get(chatId)?.active) {
            await updateStatusMessage(chatId, currentSession);
            saveSessions();
          }
        }
      }
    } catch (err: any) {
      logger.error('Search loop crash, restarting...', { error: err.message });
      if (browser) await browser.close().catch(() => {});
      browser = null;
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  if (browser) await browser.close().catch(() => {});
}
