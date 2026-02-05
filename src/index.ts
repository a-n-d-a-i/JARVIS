#!/usr/bin/env node
/**
 * NanoClaw - Single File Version
 *
 * A minimal Telegram-to-Claude bridge.
 * One chat, one assistant, no features beyond responding to messages.
 *
 * Usage:
 *   npm install grammy @anthropic-ai/sdk
 *   TELEGRAM_BOT_TOKEN=xxx tsx nanoclaw.ts
 */

import { Bot, Context } from 'grammy';
import { Anthropic } from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

// ========== CONFIG ==========

const ASSISTANT_NAME = 'JARVIS';
const HISTORY_FILE = path.join(process.cwd(), 'history.jsonl');
const MAX_HISTORY = 100;

// ========== STATE ==========

let bot: Bot;
const anthropic = new Anthropic();

// ========== HISTORY ==========

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
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

function addToHistory(role: 'user' | 'assistant', content: string): void {
  const history = loadHistory();
  history.push({ role, content, timestamp: new Date().toISOString() });
  // Keep only recent messages
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  saveHistory(history);
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

  // Handle all text messages
  bot.on('message:text', async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg) return;

    const text = msg.text;
    if (!text) return;

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Skip commands other than /start
    if (text.startsWith('/') && text !== '/start') {
      return;
    }

    console.log(`\n[${new Date().toLocaleTimeString()}] Received: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);

    // Show typing indicator
    await ctx.api.sendChatAction(chatId, 'typing');

    // Get Claude response
    try {
      const response = await getResponse(text);
      console.log(`[${new Date().toLocaleTimeString()}] Sent: ${response.slice(0, 100)}${response.length > 100 ? '...' : ''}`);

      await ctx.reply(`${ASSISTANT_NAME}: ${response}`);

      addToHistory('user', text);
      addToHistory('assistant', response);
    } catch (err) {
      console.error('Error:', err);
      await ctx.reply(`${ASSISTANT_NAME}: Sorry, something went wrong.`);
    }
  });

  // Start polling
  await bot.start();
}

// ========== CLAUDE ==========

async function getResponse(userMessage: string): Promise<string> {
  const history = loadHistory();

  // Convert to Anthropic format (last 20 messages for context)
  const messages = history
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content }));

  // Add current message
  messages.push({ role: 'user', content: userMessage });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    messages,
    system: `You are ${ASSISTANT_NAME}, a helpful AI assistant. Respond concisely and conversationally. Personality: 50% Alfred from Batman, 50% JARVIS from Iron Man.`
  });

  const block = response.content.find(b => b.type === 'text');
  return block && 'text' in block ? block.text : 'Sorry, I could not generate a response.';
}

// ========== MAIN ==========

async function main(): Promise<void> {
  console.log('NanoClaw - Single File Version\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable not set');
    process.exit(1);
  }

  await connectTelegram();
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
