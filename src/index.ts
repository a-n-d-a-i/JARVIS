#!/usr/bin/env node

// USAGE: Just talk normally to Claude/Codex
// say reset to reset chat
// Start message with $ to run shell commands, e.g. $date

const USE_CLAUDE = true; // false -> use Codex
const ALLOWED_CHAT_IDS = [Number(process.env.MY_TG_CHAT_ID)];

const os = require('os');
const { exec } = require('child_process') as typeof import('child_process');
import { Bot, Context } from 'grammy';

const RESET_CMD: string = USE_CLAUDE
  ? `claude -p '(NOTE: Resetting session. Say "Session reset." and exit.)'`
  : `codex exec '(NOTE: Resetting session. Say "Session reset." and exit.)'`;
const EXEC_CMD: string = USE_CLAUDE
  ? `claude --dangerously-skip-permissions --continue -p`
  : `codex --yolo exec resume --last`;

function stripAnsi(str: string): string {
  return str.replace(/\x1b[^a-zA-Z]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g, '');
}

async function main(): Promise<void> {
  
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }
  
  const bot = new Bot(token);
  const me = await bot.api.getMe();
  console.log(`Connected: @${me.username}`);
  console.log(`Allowed: ${ALLOWED_CHAT_IDS}`);

  bot.on('message:text', async (ctx: Context) => {
    const text = ctx.message?.text;
    const chatId = ctx.chat?.id;

    if (!text || !chatId) return;

    if (!ALLOWED_CHAT_IDS.includes(chatId)) {
      await ctx.reply('Unauthorized');
      return;
    }

    let cmd: string;
    if (text == 'reset' || text == 'Reset' || text == 'reset.' || text == 'Reset.') {
      cmd = RESET_CMD;
    } else {
      cmd = EXEC_CMD + ' ' + JSON.stringify(text);
    }
    if (USE_CLAUDE) cmd = `script -q -c ${JSON.stringify(cmd)} /dev/null`; // Claude needs a TTY

    if (text.startsWith('$')) { // run a bash command instead
      cmd = text.slice(1);
    }

    // ctx.reply(`Running command: ${cmd}`); // dbg
    exec(cmd, (err, stdout, stderr) => {
      console.log(stdout + stderr);
      let out = stdout;
      if (err) { console.error(err); out += stderr; }
      if (USE_CLAUDE) out = stripAnsi(out); // remove crap
      ctx.reply(out || '(No output)');
    });
  });

  await bot.start();
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
