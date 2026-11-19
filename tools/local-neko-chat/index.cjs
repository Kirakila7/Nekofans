'use strict';

const readline = require('node:readline/promises');
const {once} = require('node:events');
const {stdin, stdout} = require('node:process');
const {NekoChat, localBase} = require('./neko-chat.cjs');

async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('node tools/local-neko-chat/index.cjs [本机 N.E.K.O. 地址] [聊天角色]');
    return;
  }
  if (args.length > 2) throw Error('参数过多，请用 --help 查看用法。');
  const [address, character = '大肥鱼'] = args;
  const baseUrl = localBase(address);
  if (!character.trim() || character.length > 80) throw Error('请选择已有聊天角色，名字最多 80 个字符。');
  const chat = new NekoChat();
  const controller = new AbortController();
  const input = readline.createInterface({input: stdin, output: stdout});
  const stop = () => {
    controller.abort();
    chat.close();
    input.close();
  };
  input.once('SIGINT', stop);
  input.once('close', () => {
    if (!controller.signal.aborted) {
      controller.abort();
      chat.close();
    }
  });
  process.once('SIGTERM', stop);
  try {
    await chat.connect({baseUrl, character: character.trim()});
    if (controller.signal.aborted) return;
    console.log(`已连接 ${chat.character}。输入 /exit 退出。`);
    while (!controller.signal.aborted) {
      let message;
      try { message = (await input.question('你：', {signal:controller.signal})).trim(); }
      catch (error) {
        if (controller.signal.aborted || error.code === 'ERR_USE_AFTER_CLOSE') break;
        throw error;
      }
      if (message === '/exit') break;
      if (!message) continue;
      const wait = new AbortController();
      const reply = once(chat, 'complete', {signal:wait.signal});
      const failure = once(chat, 'failure', {signal:wait.signal}).then(([error]) => { throw error; });
      const result = Promise.race([reply, failure]);
      try {
        chat.send(message);
        const [response] = await result;
        console.log(`${chat.character}：${response.text}`);
      } catch (error) {
        if (!controller.signal.aborted) console.error(error.message);
      } finally {
        wait.abort();
      }
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    input.removeListener('SIGINT', stop);
    stop();
  }
}

run(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
