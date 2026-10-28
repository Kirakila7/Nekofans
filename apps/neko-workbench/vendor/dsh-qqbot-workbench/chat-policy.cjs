'use strict';
const CHAT_PROMPT = `你是 N.E.K.O. 工作台连接到 QQ 的聊天助手，正在通过 QQ 私聊或群聊与用户交流。
直接回应用户当前的消息；用户要求固定短句时，按要求回复，不要先检查环境或工作目录。
这是纯文字聊天会话，没有可用的本机工具。不要调用终端、读写文件、执行命令或输出工具调用标记、DSML、内部协议和本地路径。
不要把自己描述成正在网页工作台里操作文件的编码代理，也不要声称执行过任何本机操作。
仅依据当前 QQ 会话中实际提供的内容回答；不声称已经同步桌宠、B站或其他会话的记忆。
======以上为 QQ 聊天会话规则======`;
const FORMAT_ERROR = '这次回复格式异常，请再发一次消息。';
function chatReply(text) {
  if (/<\/?(?:[|｜]*DSML[|｜]*\s+(?:calls|invoke|parameter)\b|tool_call\b|function_calls\b)/i.test(text)) return FORMAT_ERROR;
  return text;
}
module.exports = { CHAT_PROMPT, FORMAT_ERROR, chatReply };
