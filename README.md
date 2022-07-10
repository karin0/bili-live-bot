# bili-live-bot

实时监听 bilibili 直播间的弹幕，并通过 Telegram Bot 转发到频道/群/用户。可提示观众进入、送礼、SC 等特殊事件。

为控制 API 请求频率，收到大量弹幕时，多条弹幕可能被合并在单条消息中。与直播间的连接断开或超时时，会自动进行重连，可长时间运行。

## 安装

```shell
$ git clone https://github.com/karin0/bili-live-bot.git
$ cd bili-live-bot
$ pnpm install
```

## 运行

需要[获取 Bot token](https://core.telegram.org/bots#3-how-do-i-create-a-bot)，并在环境变量中设置。

```shell
$ export BOT_TOKEN=<your-bot-token>
$ node index.js
```

## 使用

关注该 Bot 的用户可直接发送命令，通过直播间编号（可在直播间链接中找到）添加监听的直播间：

```
/watch <room-id>
/unwatch <room-id>
/show
```

运行服务端时，还可传入初始监听的直播间编号和对应的 chat id，可自动在频道或群组中推送弹幕：

```shell
$ node index.js <chat-id>:<room-id>
```

频道或群组的 chat id 可能以 -100 开头。
