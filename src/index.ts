#!/usr/bin/env node
/**
 * Vision - Single File Version
 *
 * A minimal Telegram-to-Claude bridge.
 * One chat, one assistant, no features beyond responding to messages.
 *
 * Usage:
 *   npm install grammy @anthropic-ai/sdk
 *   export TELEGRAM_BOT_TOKEN=xxx 
 *   npm run dev
 */

import { Bot, Context } from 'grammy';
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';
import path from 'path';

// ========== CONFIG ==========

const ASSISTANT_NAME = 'JARVIS';
const HISTORY_FILE = path.join(process.cwd(), 'history.jsonl');
const MAX_HISTORY = 100;
const ALLOWED_CHAT_IDS = [ Number(process.env.MY_TG_CHAT_ID) ]
console.log('Allowed Chat IDs');
console.log(ALLOWED_CHAT_IDS)

// ========== STATE ==========

let bot: Bot;
const sessionStore: Map<number, string> = new Map(); // chatId -> sessionId

// ========== HISTORY ==========

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  chatId?: number;
  sessionId?: string;
}

function loadHistory(): Message[] {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  const lines = fs.readFileSync(HISTORY_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.map(line => JSON.parse(line));
}

function saveHistory(history: Message[]): void {
  const lines = history.map(m => JSON.stringify(m)).join('\n');
  fs.writeFileSync(HISTORY_FILE, lines);
}

function addToHistory(role: 'user' | 'assistant', content: string, chatId?: number, sessionId?: string): void {
  const history = loadHistory();
  history.push({ role, content, timestamp: new Date().toISOString(), chatId, sessionId });
  // Keep only recent messages
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  saveHistory(history);
}

function getSessionId(chatId: number): string | undefined {
  const history = loadHistory();
  // Find most recent session for this chat
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].chatId === chatId && history[i].sessionId) {
      return history[i].sessionId;
    }
  }
  return sessionStore.get(chatId);
}

function clearSession(chatId: number): void {
  sessionStore.delete(chatId);
}

// ========== TELEGRAM ==========

async function connectTelegram(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN environment variable not set');
    process.exit(1);
  }

  bot = new Bot(token);

  // Get bot info
  const me = await bot.api.getMe();
  console.log(`\n✓ Connected to Telegram`);
  console.log(`✓ Bot: @${me.username}`);
  console.log(`✓ Assistant: ${ASSISTANT_NAME}`);
  console.log(`✓ Send /start or any message to chat\n`);

  // Handle /reset command
  bot.command('reset', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    if (!ALLOWED_CHAT_IDS.includes(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    clearSession(chatId);
    await ctx.reply('Session cleared.');
  });

  // Handle /status command
  bot.command('status', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    if (!ALLOWED_CHAT_IDS.includes(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    const sessionId = getSessionId(chatId);
    await ctx.reply(`Session: ${sessionId ? sessionId.slice(0, 8) + '...' : 'none'}`);
  });

  // Handle all text messages
  bot.on('message:text', async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg) return;

    const text = msg.text;
    if (!text) return;

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Auth check
    if (!ALLOWED_CHAT_IDS.includes(chatId)) {
      console.log('Unauthorized ID: ' + chatId)
      await ctx.reply('Unauthorized.');
      return;
    }

    // Skip commands handled elsewhere
    if (text.startsWith('/')) {
      if (text === '/start') {
        await ctx.reply(`${ASSISTANT_NAME} ready. Full agent capabilities enabled.`);
      }
      return;
    }

    console.log(`\n[${new Date().toLocaleTimeString()}] Received: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);

    // Get agent response
    try {
      const response = await getAgentResponse(text, chatId, ctx);
      console.log(`[${new Date().toLocaleTimeString()}] Sent: ${response.slice(0, 100)}${response.length > 100 ? '...' : ''}`);

      addToHistory('user', text, chatId);
      addToHistory('assistant', response, chatId);
    } catch (err) {
      console.error('Error:', err);
      await ctx.reply(`${ASSISTANT_NAME}: Error occurred.`);
    }
  });

  // Start polling
  await bot.start();
}

// ========== AGENT ==========

async function getAgentResponse(userMessage: string, chatId: number, ctx: Context): Promise<string> {
  const sessionId = getSessionId(chatId);

  let lastUpdate = Date.now();
  let statusMessage: any = null;
  let finalResponse = '';
  let currentSessionId = '';

  try {
    const q = query({
      prompt: userMessage,
      options: {
        resume: sessionId,
        cwd: '/agent',
        allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'Skill', 'NotebookEdit'],
        canUseTool: async () => ({ behavior: 'allow' })
      }
    });

    // Iterate through messages
    for await (const msg of q) {
      // Update typing every 5s
      const now = Date.now();
      if (now - lastUpdate > 5000) {
        lastUpdate = now;
        try {
          await ctx.api.sendChatAction(chatId, 'typing');
        } catch {}
      }

      // Track session ID
      if ('session_id' in msg) {
        currentSessionId = msg.session_id;
      }

      // Show tool usage
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            const status = `${ASSISTANT_NAME}: ${block.name}...`;

            if (!statusMessage) {
              statusMessage = await ctx.reply(status);
            } else {
              try {
                await ctx.api.editMessageText(chatId, statusMessage.message_id, status);
              } catch {}
            }
          }

          if (block.type === 'text') {
            finalResponse += block.text;
          }
        }
      }
    }

    // Store session
    if (currentSessionId) {
      sessionStore.set(chatId, currentSessionId);
      addToHistory('assistant', '', chatId, currentSessionId);
    }

    // Send final response
    const output = finalResponse || 'Done.';

    if (statusMessage) {
      try {
        await ctx.api.editMessageText(chatId, statusMessage.message_id, `${ASSISTANT_NAME}: ${output}`);
      } catch {
        await ctx.reply(`${ASSISTANT_NAME}: ${output}`);
      }
    } else {
      await ctx.reply(`${ASSISTANT_NAME}: ${output}`);
    }

    return output;
  } catch (err) {
    throw err;
  }
}

// ========== MAIN ==========

async function main(): Promise<void> {
  console.log('VISION\n');

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error('Error: no auth method set');
    process.exit(1);
  }

  console.log(`✓ Allowed chats: ${ALLOWED_CHAT_IDS.join(', ')}`);
  console.log(`✓ Working directory: /agent`);

  await connectTelegram();
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
