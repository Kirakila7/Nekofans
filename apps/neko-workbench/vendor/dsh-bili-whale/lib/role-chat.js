import { randomUUID } from 'node:crypto'

export function createRoleChat({ subscribe, deliver, signal, timeoutMs = 65000 }) {
  let busy = false
  return async function chat(text) {
    if (busy) throw Error('角色正在回复，请稍等。')
    busy = true
    const requestId = 'neko-role-' + randomUUID()
    const deadline = new AbortController()
    const turnSignal = AbortSignal.any([signal, deadline.signal])
    let sessionId, currentTurn, ownTurn, reply = '', off, accepted = false, completed = false
    const timer = setTimeout(() => deadline.abort(Error('等待角色回复超时，请在原 DSH 会话查看。')), timeoutMs)
    try {
      const result = new Promise((resolve, reject) => {
        turnSignal.addEventListener('abort', () => reject(turnSignal.reason), { once: true })
        turnSignal.throwIfAborted()
        off = subscribe((session, event) => {
          if (!sessionId || session?.header?.id !== sessionId) return
          const { type, data } = event
          if (type === 'turn/start') currentTurn = data?.turn
          if (type === 'user/message' && data?.source?.rpcId === requestId) ownTurn = data.turn ?? currentTurn
          if (ownTurn == null || data?.turn !== ownTurn) return
          if (type === 'assistant/message' && !data.interrupted) {
            const content = data.message?.content
            const text = typeof content === 'string' ? content : Array.isArray(content)
              ? content.filter(block => block.type === 'text').map(block => block.text).join('') : ''
            if (text.trim()) reply = text.slice(0, 16000)
          }
          if (type === 'turn/end') {
            if (data.reason?.kind !== 'completed' || !reply) {
              reject(Error('原 DSH 会话未返回完整回复，请在工作台查看。'))
              return
            }
            completed = true
            if (accepted) resolve({ text: reply })
          }
        })
        Promise.resolve().then(() => deliver(
          { requestId, mode: 'queue', content: [{ type: 'text', text }] },
          turnSignal, id => { sessionId = id },
        )).then(() => {
          accepted = true
          if (completed) resolve({ text: reply })
        }, reject)
      })
      return await result
    } finally {
      clearTimeout(timer)
      deadline.abort()
      off?.()
      busy = false
    }
  }
}
