const { KeepLiveTCP, getRoomid } = require('bilibili-live-ws');
const { Telegram, Telegraf } = require('telegraf');
const { escape } = require('html-escaper');

const { BOT_TOKEN } = process.env;
if (!BOT_TOKEN) {
  console.error('Environment variable BOT_TOKEN is required');
  process.exit(10);
}

const TG_SEND_INTERVAL = 100;
const MAX_USER_WATCH_NUM = 5;

const tg = new Telegram(BOT_TOKEN);

class NamePart {
  constructor(uid, uname, medal_info) {
    if (medal_info) {
      const { medal_level, medal_name } = medal_info;
      if (medal_name)
        uname = `[${medal_name} ${medal_level}] ` + uname;
    }
    this.uid = uid;
    this.text = uname;
  }

  render_html() {
    return `${escape(this.text)} (${this.uid})`;
  }

  render_log() {
    return `${this.text} (${this.uid})`;
  }

  get url() {
    return 'https://space.bilibili.com/' + this.uid;
  }
}

class RoomPart {
  constructor(room_id) {
    this.room_id = room_id;
  }

  render_html() {
    return '#room_' + this.room_id;
  }

  render_log() {
    return '#' + this.room_id + ':';
  }
}

const SEP = '\n';

function render_part_html(o) {
  if (o === SEP)
    return '\n';
  if (typeof o === 'string')
    return escape(o);
  if (Array.isArray(o))
    return o.map(render_part_html).join('');
  return o.render_html();
}

function render_part_log(o) {
  if (o === SEP)
    return ' ';
  if (typeof o === 'string')
    return o;
  if (Array.isArray(o))
    return o.map(render_part_log).join('');
  return o.render_log();
}

function root_send(msg, chat_id) {
  console.log(render_part_log(msg));
  msg = render_part_html(msg);

  const f = () => tg.sendMessage(chat_id, msg, {
    parse_mode: 'HTML',
  });

  f().catch(e => {
    console.error(chat_id, 'tg send error:', e);
    if (String(e).includes('400'))
      return;
    // TODO: check the reason, don't retry if the user has removed the bot or other non-network stuff.
    f().catch(e => {
      console.error('tg send retry error', e)
    });
  });
}

class HandleQueue {
  constructor() {
    this.arr = [];
    this.worker = this.worker.bind(this);
    this.cd = new Promise(r => r());
  }

  push(handle) {
    if (handle.scheduled)
      return;
    handle.scheduled = true;
    this.arr.push(handle);
    if (this.arr.length === 1)
      this.cd.then(this.worker);
  }

  worker() {
    const handle = this.arr.shift();
    handle.scheduled = false;
    console.log(handle.msgs.length, 'msgs to', handle.chat_id, 'from #' + handle.room_id + ',', this.arr.length, 'handles left');

    // TODO: do this async?
    const msg = [];  // handle.room_part
    for (const m of handle.msgs)
      msg.push(m, SEP);
    msg.pop();
    handle.msgs = [];
    root_send(msg, handle.chat_id);

    // TODO: drop the timeout when cleaning up?
    if (this.arr.length)
      setTimeout(this.worker, TG_SEND_INTERVAL);
    else
      this.cd = new Promise(r => setTimeout(r, TG_SEND_INTERVAL));
  }
}

const handle_queue = new HandleQueue();

class WatchHandle {
  constructor(room_id, chat_id) {
    this.room_id = room_id;
    this.room_part = new RoomPart(room_id);
    this.chat_id = chat_id;
    this.msgs = [];
    this.scheduled = false;
  }

  send(msg) {
    this.msgs.push(msg);
    handle_queue.push(this);
  }
}

class Live {
  constructor(room_id) {
    console.log('Connecting to live room', room_id);
    const live = new KeepLiveTCP(room_id);
    this.room_id = room_id;
    this.live = live;
    const handle_map = new Map();
    this.handle_map = handle_map;

    function send(msg) {
      for (const handle of handle_map.values())
        handle.send(msg);
    }

    live.on('open', () => {
      console.log('Connection established to room', room_id);
    });

    live.on('live', () => {
      console.log('Connected to room', room_id);
    });

    live.on('close', () => {
      console.log('Disconnected from room', room_id)
    });

    this.online = null;
    this.first_online_fut = new Promise(resolve => {
      live.on('heartbeat', online => {
        console.log('Heartbeat from room', room_id, 'online', online);
        if (this.online == null) {
          this.online = online;
          resolve(online);
          return;
        }
        if (this.online !== online) {
          this.online = online;
          send('人气值 ' + online);
        }
      });
    });

    live.on('DANMU_MSG', fullData => {
      const { info: [, message, [uid, uname], [medal_level, medal_name]] } = fullData;
      const medal_info = medal_name ? { medal_level, medal_name } : null;
      const name = new NamePart(uid, uname, medal_info);
      send([name, ':', SEP, message]);
    });

    function register(cmd, callback) {
      live.on(cmd, ({ data }) => {
        send(callback(data));
      })
    }

    register('SEND_GIFT', data => {
      const { uid, uname, action, giftName, num, super_gift_num, medal_info } = data;
      const name = new NamePart(uid, uname, medal_info);
      const msg = [name, ` ${action} ${giftName} x ${num}`];
      if (super_gift_num)
        msg.push(` (${super_gift_num})`);
      return msg;
    });

    // SC
    register('SUPER_CHAT_MESSAGE', data => {
      const {
        uid,
        user_info: { uname },
        medal_info,
        message,
        price,
      } = data;
      const name = new NamePart(uid, uname, medal_info);
      return [name, ` (SC ￥${price}):`, SEP, message];
    });

    register('SUPER_CHAT_MESSAGE_JPN', data => {
      const {
        uid,
        user_info: { uname },
        medal_info,
        message,
        message_jpn,
        price,
      } = data;
      const name = new NamePart(uid, uname, medal_info);
      return [name, ` (SC_JPN ￥${price}):`, SEP, message, SEP, `JPN: ` + message_jpn];
    });

    // 舰长
    register('USER_TOAST_MSG', data => {
      const {
        uid, username: uname, role_name: giftName, num
      } = data;
      const name = new NamePart(uid, uname);
      return [name, ` 舰长 ${giftName} x ${num}`];
    });

    register('INTERACT_WORD', data => {
      const {
        fans_medal, uid, uname
      } = data;
      const name = new NamePart(uid, uname, fans_medal);
      return [name, ' 进入'];
    });
  }

  close() {
    this.live.close();
  }

  watch(chat_id) {
    const m = this.handle_map;
    if (m.has(chat_id))
      return false;
    m.set(chat_id, new WatchHandle(this.room_id, chat_id));
    return true;
  }

  unwatch(chat_id) {
    const handle = this.handle_map.get(chat_id);
    if (handle) {
      handle.scheduled = false;
      this.handle_map.delete(chat_id);
      return true;
    }
    return false;
  }

  idle() {
    return !this.handle_map.size;
  }

  get_online() {
    if (this.online != null)
      return this.online;
    return this.first_online_fut;
  }
}

const bot = new Telegraf(BOT_TOKEN);
const live_map = new Map();

function clean_up(reason) {
  // The listening bot must be stopped before closing lives, or new lives could be created
  console.warn(reason, 'received, closing the bot and', live_map.size, 'lives');
  try {
    bot.stop(reason);
  } catch (e) {
    console.error('Failed to stop the bot:', e);
  }
  for (const live of live_map.values())
    live.close();
}

process.once('SIGINT', () => {
  clean_up('SIGINT');
});

process.once('SIGTERM', () => {
  clean_up('SIGTERM');
});

function parse_room_id(ctx) {
  const a = ctx.update.message.text.split(' ', 2);
  if (a.length !== 2)
    return Number.NaN;
  return Number.parseInt(a[1], 10);
}

const watching_map = new Map();

function add_watch(chat_id, room_id) {
  let s = watching_map.get(chat_id);
  if (s) {
    if (s.has(room_id))
      return [false, live_map.get(room_id)];
    if (s.size >= MAX_USER_WATCH_NUM)
      return [false, null];
  } else {
    s = new Set();
    watching_map.set(chat_id, s);
  }
  let live = live_map.get(room_id);
  if (!live) {
    live = new Live(room_id);
    live_map.set(room_id, live);
  }
  if (!live.watch(chat_id))
    throw new Error(`watch failed unexpectedly ${room_id} ${chat_id}`);
  s.add(room_id);
  console.log(chat_id, 'started watching on room', room_id);
  return [true, live];
}

function remove_watch(chat_id, room_id) {
  const live = live_map.get(room_id);
  if (!live || !live.unwatch(chat_id))
    return false;
  watching_map.get(chat_id).delete(room_id);
  if (live.idle()) {
    live.close();
    live_map.delete(room_id);
  }
  console.log(chat_id, 'stopped watching on room', room_id);
  return true;
}

bot.command('watch', async ctx => {
  const chat_id = ctx.chat.id;
  const room_id = parse_room_id(ctx);
  if (Number.isNaN(room_id))
    return ctx.reply('Usage: /watch <room_id>');

  const id = await getRoomid(room_id);
  if (id == null || Number.isNaN(id))
    return ctx.reply(`Room ${room_id} does not exist.`);

  const [ok, live] = add_watch(chat_id, id);
  if (!live)
    return ctx.reply('You are not permitted to watch more than ' + MAX_USER_WATCH_NUM + ' rooms.');

  const online = await live.get_online();
  if (!ok)
    return ctx.reply('You are already watching this room, 🔥 ' + online);
  const res = 'Done, 🔥 ' + online;
  if (id === room_id)
    ctx.reply(res);
  else
    ctx.reply(`${res} (resolved to <a href="https://live.bilibili.com/${id}">${id}</a>)`, {
      parse_mode: 'HTML'
    });
});

bot.command('unwatch', ctx => {
  const chat_id = ctx.chat.id;
  const room_id = parse_room_id(ctx);
  if (Number.isNaN(room_id))
    return ctx.reply('Usage: /unwatch <room_id>');

  if (!remove_watch(chat_id, room_id))
    return ctx.reply('You are not watching this room.');
  ctx.reply('Done!');
});

bot.command('show', ctx => {
  const chat_id = ctx.chat.id;
  const s = watching_map.get(chat_id);
  if (!s || !s.size)
    return ctx.reply('You are not watching any room.');
  return ctx.reply('Watching rooms:\n' + Array.from(s).map(room_id => {
    return `[${room_id}](https://live.bilibili.com/${room_id})`;
  }).join(', '), {
    'parse_mode': 'MarkdownV2'
  });
});

function init() {
  console.log('Starting bot');
  bot.launch().then(() => {
    console.log('Bot started');
  });

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    const arr = arg.split(':', 2);
    if (arr.length != 2) {
      console.error('unrecognized:', arg);
      continue;
    }
    const chat_id = Number.parseInt(arr[0], 10);
    const room_id = Number.parseInt(arr[1], 10);
    if (Number.isNaN(chat_id) || Number.isNaN(room_id)) {
      console.error('unrecognized:', arg);
      continue;
    }
    const [ok, _] = add_watch(chat_id, room_id);
    if (ok)
      console.log('added chat', chat_id, '<- room', room_id);
    else
      console.error('failed to add chat', chat_id, '<- room', room_id);
  }
}

init();
