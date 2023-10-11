import asyncio
import http.cookies
import logging
import os
import sys
import time
import aiohttp
import telegram
import tenacity as tc

sys.path.append('blivedm')

import blivedm
import blivedm.models.web as web_models


def get_logger():
    if os.environ.get('DEBUG') == '1':
        level = logging.DEBUG
    else:
        level = logging.INFO

    if 'JOURNAL_STREAM' in os.environ:
        fmt = '[%(levelname)s] %(message)s'
    else:
        fmt = '%(asctime)s [%(levelname)s] %(message)s'

    logger = logging.getLogger('live_bot')
    logger.setLevel(level)
    h = logging.StreamHandler()
    h.setLevel(level)
    h.setFormatter(logging.Formatter(fmt))
    logger.addHandler(h)
    return logger


log = get_logger()


def init_session():
    cookies = http.cookies.SimpleCookie()
    cookies['SESSDATA'] = os.environ['SESSDATA']
    cookies['SESSDATA']['domain'] = 'bilibili.com'

    session = aiohttp.ClientSession()
    session.cookie_jar.update_cookies(cookies)
    return session


SESSION = None


class Live:
    insts = {}

    @classmethod
    def get(cls, room_id):
        try:
            return cls.insts[room_id]
        except KeyError:
            cls.insts[room_id] = r = cls(room_id)
            return r

    def __init__(self, room_id) -> None:
        self.room_id = room_id
        self.subscribers = []
        self.started = False
        handler = LiveHandler(self._callback)
        self.client = blivedm.BLiveClient(room_id, session=SESSION)
        self.client.set_handler(handler)

    def _callback(self, *txts):
        txt = ' '.join(map(str, txts))
        log.info('[%d] %s', self.room_id, txt.replace('\n', ' '))
        for f in self.subscribers:
            try:
                f(self, txt)
            except Exception as e:
                log.exception('live callback: %s', e)

    def subscribe(self, f):
        self.subscribers.append(f)

    def start(self):
        if not self.started:
            self.started = True
            self.client.start()

    async def join(self):
        await self.client.join()

    async def close(self):
        await self.client.stop_and_close()


class BufferedChat:
    def __init__(self, bot, chat_id):
        self.bot = bot
        self.chat_id = chat_id
        self.buffer = []
        self.event = asyncio.Event()
        self.task = asyncio.create_task(self._worker())

    @tc.retry(
        wait=tc.wait_fixed(1),
        stop=tc.stop_after_attempt(3),
        retry=tc.retry_if_exception_type(telegram.error.NetworkError),
        before_sleep=tc.before_sleep_log(log, logging.WARNING),
    )
    async def _send(self, msg):
        await self.bot.send_message(self.chat_id, msg)

    async def _flush(self):
        log.debug('@%d: flushing %d messages', self.chat_id, len(self.buffer))
        assert self.buffer
        msg = '\n'.join(self.buffer)
        self.buffer.clear()
        try:
            await self._send(msg)
        except tc.RetryError:
            log.error('@%d: failed to send %s', self.chat_id, repr(msg))

    async def _worker(self):
        cool = time.monotonic()
        while True:
            await self.event.wait()
            dt = cool - time.monotonic()
            log.debug('@%d: woke at %s - %s', self.chat_id, cool, dt)
            if dt > 0:
                await asyncio.sleep(dt)
            await self._flush()
            while self.buffer:
                await asyncio.sleep(0.1)
                await self._flush()
            cool = time.monotonic() + 0.1
            self.event.clear()

    def send(self, text):
        log.debug('@%d: sending %s', self.chat_id, repr(text))
        self.buffer.append(text)
        self.event.set()


def make_chat_callback(chat):
    def f(live, s):
        log.debug('#%d: live callback: %s', live.room_id, repr(s))
        chat.send(s)

    return f


async def main():
    args = sys.argv[1:]
    if not args:
        print(f'Usage: {sys.executable} {sys.argv[0]} <chat_id>:<room_id> ...', file=sys.stderr)
        sys.exit(-1)

    global SESSION
    SESSION = init_session()
    try:
        bot = telegram.Bot(os.environ['BOT_TOKEN'])
        async with bot:
            tasks = []
            for arg in args:
                chat_id, room_id = map(int, arg.split(':', 1))
                log.info('Room %d -> Chat %d', room_id, chat_id)
                chat = BufferedChat(bot, chat_id)
                live = Live.get(room_id)
                live.subscribe(make_chat_callback(chat))
                live.start()
                chat.send(f'Up: {room_id}')
                tasks.append(chat.task)

            tasks += [
                asyncio.create_task(live.join()) for live in Live.insts.values()
            ]
            log.debug('waiting for %d tasks', len(tasks))
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            raise RuntimeError('Connection aborted unexpectedly')
    finally:
        await SESSION.close()


def user(msg):
    try:
        s = msg.uname
    except AttributeError:
        s = msg.username

    try:
        s += f' ({msg.uid})'
    except AttributeError:
        pass

    try:
        if msg.medal_name:
            s = f'[{msg.medal_name} {msg.medal_level}] ' + s
    except AttributeError:
        pass

    return s


class DictProxy:
    def __init__(self, _inner: dict) -> None:
        self._inner = _inner

    def __getattr__(self, name):
        try:
            return self._inner[name]
        except KeyError:
            raise AttributeError(name)


class LiveHandler(blivedm.BaseHandler):
    def __init__(self, callback):
        self.cb = callback
        self.popularity = None

    _CMD_CALLBACK_DICT = blivedm.BaseHandler._CMD_CALLBACK_DICT.copy()

    # 入场消息回调
    def __interact_word_callback(self, client: blivedm.BLiveClient, command: dict):
        u = user(DictProxy(command['data']))
        self.cb(u, '进入')

    _CMD_CALLBACK_DICT['INTERACT_WORD'] = __interact_word_callback

    def _on_heartbeat(self, client: blivedm.BLiveClient, msg: web_models.HeartbeatMessage):
        pop = msg.popularity
        if pop != self.popularity:
            self.popularity = pop
            self.cb('人气值', pop)

    def _on_danmaku(self, client: blivedm.BLiveClient, msg: web_models.DanmakuMessage):
        self.cb(user(msg) + ':\n' + msg.msg)

    def _on_gift(self, client: blivedm.BLiveClient, msg: web_models.GiftMessage):
        coin = msg.coin_type
        if coin == 'gold':
            coin = '金'
        elif coin == 'silver':
            coin = '银'

        self.cb(user(msg), f'赠送 {msg.gift_name} x {msg.num}（{coin}瓜子 x {msg.total_coin}）')

    def _on_buy_guard(self, client: blivedm.BLiveClient, msg: web_models.GuardBuyMessage):
        self.cb(user(msg), f'购买 {msg.gift_name}')

    def _on_super_chat(self, client: blivedm.BLiveClient, msg: web_models.SuperChatMessage):
        self.cb(f'SC ¥{msg.price}\n' + user(msg) + '\n' + msg.message)


if __name__ == '__main__':
    asyncio.run(main())
