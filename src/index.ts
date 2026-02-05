#!/usr/bin/env node
/**
 * Vision
 *
 * A minimal Telegram-to-Claude bridge with autonomous capabilities.
 * Features: Chat, persistent sessions, heartbeat monitoring, cron scheduling.
 *
 * Usage:
 *   npm install grammy @anthropic-ai/claude-agent-sdk node-cron
 *   TELEGRAM_BOT_TOKEN=xxx ANTHROPIC_API_KEY=xxx MY_TG_CHAT_ID=xxx tsx Vision.ts
 */

import { Bot, Context } from 'grammy';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as cron from 'node-cron';
import fs from 'fs';
import path from 'path';

// ========== CONFIG ==========

const VISION_HOMEDIR = process.env.VISION_HOMEDIR || '/agent/Vision';
const ASSISTANT_NAME = 'JARVIS';
const HISTORY_FILE = path.join(VISION_HOMEDIR, 'history.jsonl');
const HEARTBEAT_FILE = path.join(VISION_HOMEDIR, 'HEARTBEAT.md');
const HEARTBEAT_STATE_FILE = path.join(VISION_HOMEDIR, 'heartbeat-state.json');
const ALERTS_FILE = path.join(VISION_HOMEDIR, 'ALERTS.txt');
const CRON_STATE_FILE = path.join(VISION_HOMEDIR, 'cron-state.json');
const MEMORY_FILE = path.join(process.cwd(), 'MEMORY.md');
const MAX_HISTORY = 100;
const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 minutes
const ALERT_CHECK_INTERVAL = 30 * 1000; // 30 seconds
const ALLOWED_CHAT_IDS = [Number(process.env.MY_TG_CHAT_ID)];

console.log('Allowed Chat IDs:', ALLOWED_CHAT_IDS);

// ========== STATE ==========

let bot: Bot;
const sessionStore: Map<number, string> = new Map(); // chatId -> sessionId
let memoryContent: string = '';

// ========== MEMORY ==========

function loadMemory(): string {
  if (!fs.existsSync(MEMORY_FILE)) {
    console.log('[Memory] MEMORY.md not found, skipping...');
    return '';
  }

  try {
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    console.log(`✓ Loaded MEMORY.md (${content.length} bytes)`);
    return content;
  } catch (err) {
    console.error('[Memory] Failed to load MEMORY.md:', err);
    return '';
  }
}

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

// ========== HEARTBEAT ==========

interface HeartbeatState {
  lastRun: string;
  lastChecks: Record<string, any>;
}

function loadHeartbeatState(): HeartbeatState {
  if (!fs.existsSync(HEARTBEAT_STATE_FILE)) {
    return { lastRun: new Date().toISOString(), lastChecks: {} };
  }
  return JSON.parse(fs.readFileSync(HEARTBEAT_STATE_FILE, 'utf-8'));
}

function saveHeartbeatState(state: HeartbeatState): void {
  fs.writeFileSync(HEARTBEAT_STATE_FILE, JSON.stringify(state, null, 2));
}

async function runHeartbeat(): Promise<void> {
  if (!fs.existsSync(HEARTBEAT_FILE)) {
    console.log('[Heartbeat] No HEARTBEAT.md file found, skipping...');
    return;
  }

  const heartbeatContent = fs.readFileSync(HEARTBEAT_FILE, 'utf-8');
  if (!heartbeatContent.trim()) {
    return;
  }

  console.log(`\n[${new Date().toLocaleTimeString()}] Running heartbeat check...`);

  const state = loadHeartbeatState();

  try {
    const prompt = `You are ${ASSISTANT_NAME}, running an autonomous heartbeat check.

Read the HEARTBEAT.md file which contains your monitoring checklist. For each item:
1. Evaluate if the condition needs checking now
2. If yes, perform the check (use any tools you need)
3. If the condition is met and requires action, take appropriate action
4. If you need to alert the user, write the alert message to ALERTS.txt (append mode)

Current time: ${new Date().toISOString()}
Last heartbeat: ${state.lastRun}

Important guidelines:
- Be proactive but not spammy
- Only send alerts for genuinely important things
- You can update HEARTBEAT.md with status/results if needed
- You have full access to the ${VISION_HOMEDIR} directory
- To send an alert: append your message to ALERTS.txt
- Keep alerts concise and actionable

Example alert format:
echo "🔔 Disk usage is at 87% on /dev/sda1" >> ALERTS.txt

Now check the HEARTBEAT.md file and execute any necessary checks.`;

    const q = query({
      prompt,
      options: {
        cwd: VISION_HOMEDIR,
        allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task', 'WebFetch', 'WebSearch', 'Skill'],
        canUseTool: async () => ({ behavior: 'allow' })
      }
    });

    let hadOutput = false;
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            console.log(`  [Heartbeat] Using tool: ${block.name}`);
          }
          if (block.type === 'text' && block.text.trim()) {
            const text = block.text.slice(0, 200);
            console.log(`  [Heartbeat] ${text}${block.text.length > 200 ? '...' : ''}`);
            hadOutput = true;
          }
        }
      }
    }

    if (!hadOutput) {
      console.log('  [Heartbeat] ✓ All checks passed, nothing to report');
    }

    state.lastRun = new Date().toISOString();
    saveHeartbeatState(state);

  } catch (err) {
    console.error('[Heartbeat] Error:', err);
  }
}

async function startHeartbeat(): Promise<void> {
  console.log(`✓ Heartbeat enabled (${HEARTBEAT_INTERVAL / 1000 / 60} min interval)`);

  // Create default HEARTBEAT.md if it doesn't exist
  if (!fs.existsSync(HEARTBEAT_FILE)) {
    const defaultHeartbeat = `# Heartbeat Monitoring Checklist

## Always Check

- [ ] Monitor system health (disk usage, memory, load average)
- [ ] Check for critical errors in logs
- [ ] Verify important services are running

## Time-Based Checks

- [ ] Every morning at 8 AM: Send daily briefing
- [ ] Every evening at 6 PM: Summarize the day

## Status

Last check: ${new Date().toISOString()}
Issues detected: none
`;
    fs.writeFileSync(HEARTBEAT_FILE, defaultHeartbeat);
    console.log('  Created default HEARTBEAT.md');
  }

  // Run immediately on startup (after 10s delay)
  setTimeout(() => runHeartbeat(), 10000);

  // Then run periodically
  setInterval(() => {
    runHeartbeat().catch(err => {
      console.error('[Heartbeat] Failed:', err);
    });
  }, HEARTBEAT_INTERVAL);
}

// ========== ALERTS ==========

async function checkForAlerts(): Promise<void> {
  if (!fs.existsSync(ALERTS_FILE)) return;

  const alerts = fs.readFileSync(ALERTS_FILE, 'utf-8').trim();
  if (!alerts) return;

  const chatId = ALLOWED_CHAT_IDS[0];
  if (!chatId) {
    console.error('[Alert] No chat ID configured');
    return;
  }

  try {
    await bot.api.sendMessage(chatId, `🔔 ${ASSISTANT_NAME}:\n\n${alerts}`);
    console.log(`[Alert] Sent to Telegram`);
  } catch (err) {
    console.error('[Alert] Failed to send:', err);
  }

  // Clear the file
  fs.writeFileSync(ALERTS_FILE, '');
}

async function startAlertMonitor(): Promise<void> {
  console.log(`✓ Alert monitor enabled (${ALERT_CHECK_INTERVAL / 1000}s interval)`);

  setInterval(() => {
    checkForAlerts().catch(err => console.error('[Alert Check] Error:', err));
  }, ALERT_CHECK_INTERVAL);
}

// ========== CRON ==========

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  task: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

interface CronState {
  jobs: CronJob[];
}

function loadCronState(): CronState {
  if (!fs.existsSync(CRON_STATE_FILE)) {
    return { jobs: [] };
  }
  return JSON.parse(fs.readFileSync(CRON_STATE_FILE, 'utf-8'));
}

function saveCronState(state: CronState): void {
  fs.writeFileSync(CRON_STATE_FILE, JSON.stringify(state, null, 2));
}

async function executeCronTask(job: CronJob): Promise<void> {
  console.log(`\n[${new Date().toLocaleTimeString()}] Running cron job: ${job.name}`);

  try {
    const prompt = `You are ${ASSISTANT_NAME}, executing a scheduled task.

Task: ${job.task}

Current time: ${new Date().toISOString()}
Last run: ${job.lastRun || 'never'}

Execute this task now. If you need to alert the user with results, write to ALERTS.txt.`;

    const q = query({
      prompt,
      options: {
        cwd: VISION_HOMEDIR,
        allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task', 'WebFetch', 'WebSearch', 'Skill'],
        canUseTool: async () => ({ behavior: 'allow' })
      }
    });

    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            console.log(`  [Cron: ${job.name}] Using tool: ${block.name}`);
          }
          if (block.type === 'text' && block.text.trim()) {
            console.log(`  [Cron: ${job.name}] ${block.text.slice(0, 200)}`);
          }
        }
      }
    }

    // Update last run time
    const state = loadCronState();
    const jobIndex = state.jobs.findIndex(j => j.id === job.id);
    if (jobIndex !== -1) {
      state.jobs[jobIndex].lastRun = new Date().toISOString();
      saveCronState(state);
    }

    console.log(`  [Cron: ${job.name}] ✓ Completed`);

  } catch (err) {
    console.error(`[Cron: ${job.name}] Error:`, err);
  }
}

function setupCronJobs(): void {
  const state = loadCronState();

  // Parse HEARTBEAT.md for CRON directives
  if (fs.existsSync(HEARTBEAT_FILE)) {
    const content = fs.readFileSync(HEARTBEAT_FILE, 'utf-8');
    const cronPattern = /CRON\[([^\]]+)\]:\s*(.+)/g;

    let match;
    const newJobs: CronJob[] = [];

    while ((match = cronPattern.exec(content)) !== null) {
      const [_, cronExpr, task] = match;
      const jobId = `auto-${Buffer.from(task).toString('base64').slice(0, 8)}`;

      // Check if job already exists
      const existingJob = state.jobs.find(j => j.id === jobId);
      if (!existingJob) {
        newJobs.push({
          id: jobId,
          name: task.slice(0, 50),
          schedule: cronExpr,
          task: task,
          enabled: true
        });
      }
    }

    if (newJobs.length > 0) {
      state.jobs.push(...newJobs);
      saveCronState(state);
      console.log(`✓ Added ${newJobs.length} cron job(s) from HEARTBEAT.md`);
    }
  }

  // Schedule all enabled jobs
  for (const job of state.jobs.filter(j => j.enabled)) {
    if (!cron.validate(job.schedule)) {
      console.error(`[Cron] Invalid schedule for "${job.name}": ${job.schedule}`);
      continue;
    }

    console.log(`✓ Scheduled: "${job.name}" at ${job.schedule}`);

    cron.schedule(job.schedule, () => {
      executeCronTask(job).catch(err => {
        console.error(`[Cron: ${job.name}] Failed:`, err);
      });
    });
  }
}

// ========== TELEGRAM ==========

async function connectTelegram(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN environment variable not set');
    process.exit(1);
  }

  bot = new Bot(token);

  const me = await bot.api.getMe();
  console.log(`\n✓ Connected to Telegram`);
  console.log(`✓ Bot: @${me.username}`);
  console.log(`✓ Assistant: ${ASSISTANT_NAME}`);
  console.log(`✓ Send /start or any message to chat\n`);

  // Handle /reset command
  bot.command('reset', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !ALLOWED_CHAT_IDS.includes(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    clearSession(chatId);
    await ctx.reply('Session cleared.');
  });

  // Handle /status command
  bot.command('status', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !ALLOWED_CHAT_IDS.includes(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    const sessionId = getSessionId(chatId);
    const heartbeatState = loadHeartbeatState();
    const cronState = loadCronState();

    const status = `📊 ${ASSISTANT_NAME} Status

Session: ${sessionId ? sessionId.slice(0, 8) + '...' : 'none'}
Last heartbeat: ${new Date(heartbeatState.lastRun).toLocaleString()}
Cron jobs: ${cronState.jobs.filter(j => j.enabled).length} active

Working directory: ${VISION_HOMEDIR}
Alert monitoring: active`;

    await ctx.reply(status);
  });

  // Handle /heartbeat command - force run
  bot.command('heartbeat', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !ALLOWED_CHAT_IDS.includes(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    await ctx.reply('Running heartbeat check...');
    await runHeartbeat();
    await ctx.reply('Heartbeat check completed.');
  });

  // Handle /cron command - list jobs
  bot.command('cron', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !ALLOWED_CHAT_IDS.includes(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    const cronState = loadCronState();
    if (cronState.jobs.length === 0) {
      await ctx.reply('No cron jobs configured.\n\nAdd CRON directives to HEARTBEAT.md:\nCRON[0 8 * * *]: Send morning briefing');
      return;
    }

    const jobList = cronState.jobs.map((j, i) => {
      const status = j.enabled ? '✓' : '✗';
      const lastRun = j.lastRun ? new Date(j.lastRun).toLocaleString() : 'never';
      return `${i + 1}. ${status} ${j.name}\n   Schedule: ${j.schedule}\n   Last run: ${lastRun}`;
    }).join('\n\n');

    await ctx.reply(`📅 Cron Jobs:\n\n${jobList}`);
  });

  // Handle all text messages
  bot.on('message:text', async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg) return;

    const text = msg.text;
    if (!text) return;

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    if (!ALLOWED_CHAT_IDS.includes(chatId)) {
      console.log('Unauthorized ID: ' + chatId);
      await ctx.reply('Unauthorized.');
      return;
    }

    if (text.startsWith('/')) {
      if (text === '/start') {
        await ctx.reply(`${ASSISTANT_NAME} ready. Full agent capabilities enabled.\n\nFeatures:\n• Persistent sessions\n• Autonomous heartbeat monitoring\n• Scheduled cron tasks\n• Full filesystem access\n\nCommands:\n/reset - Clear session\n/status - Show status\n/heartbeat - Force heartbeat check\n/cron - List scheduled tasks`);
      }
      return;
    }

    console.log(`\n[${new Date().toLocaleTimeString()}] Received: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);

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

  await bot.start();
}

// ========== AGENT ==========

async function getAgentResponse(userMessage: string, chatId: number, ctx: Context): Promise<string> {
  const sessionId = getSessionId(chatId);

  let lastUpdate = Date.now();
  let statusMessage: any = null;
  let finalResponse = '';
  let currentSessionId = '';

  // Prepend memory content if available
  let promptWithMemory = userMessage;
  if (memoryContent) {
    promptWithMemory = `<system_context>\n${memoryContent}\n</system_context>\n\n${userMessage}`;
  }

  try {
    const q = query({
      prompt: promptWithMemory,
      options: {
        resume: sessionId,
        cwd: VISION_HOMEDIR,
        allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'Skill', 'NotebookEdit'],
        canUseTool: async () => ({ behavior: 'allow' })
      }
    });

    for await (const msg of q) {
      const now = Date.now();
      if (now - lastUpdate > 5000) {
        lastUpdate = now;
        try {
          await ctx.api.sendChatAction(chatId, 'typing');
        } catch {}
      }

      if ('session_id' in msg) {
        currentSessionId = msg.session_id;
      }

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

    if (currentSessionId) {
      sessionStore.set(chatId, currentSessionId);
      addToHistory('assistant', '', chatId, currentSessionId);
    }

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
  console.log('Vision - Full Featured Version\n');

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('Error: no auth method set');
    process.exit(1);
  }

  if (!ALLOWED_CHAT_IDS[0] || isNaN(ALLOWED_CHAT_IDS[0])) {
    console.error('Error: MY_TG_CHAT_ID not set or invalid');
    process.exit(1);
  }

  console.log(`✓ Allowed chats: ${ALLOWED_CHAT_IDS.join(', ')}`);
  console.log(`✓ Working directory: ${VISION_HOMEDIR}`);

  // Load memory file on startup
  memoryContent = loadMemory();

  await connectTelegram();

  // Start autonomous systems
  await startHeartbeat();
  await startAlertMonitor();
  setupCronJobs();

  console.log(`\n${ASSISTANT_NAME} is now running with full autonomous capabilities.\n`);
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
