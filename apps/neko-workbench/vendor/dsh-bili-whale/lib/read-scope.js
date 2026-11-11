import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// A manual reading turn can inspect its collected material and update only its
// own diary/receipt files. It never inherits shell or ACL-repair capabilities.
function readingGuard({ cwd, files, readOnlyFiles = [] }) {
  const normalize = value => process.platform==='win32' ? value.toLowerCase() : value
  const allowed = new Set(files.map(file=>normalize(path.resolve(file))))
  const readOnly = new Set(readOnlyFiles.map(file=>normalize(path.resolve(file))))
  return exec=>{
    const raw=exec.arguments?.file_path
    if(!['read','write','edit'].includes(exec.name)||typeof raw!=='string')return '本次只读养鱼仅允许读取材料和更新指定本地日记。'
    const target=path.resolve(cwd,raw)
    if(!allowed.has(normalize(target)))return '本次只读养鱼不允许访问该文件。'
    if(exec.name!=='read'&&readOnly.has(normalize(target)))return '采集材料只允许读取。'
    try{const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)return '本次只读养鱼拒绝链接文件。'}catch(error){if(error.code!=='ENOENT')return '本次只读养鱼无法确认文件状态。'}
  }
}

export async function createReadingScope(agent, { cwd, files, readOnlyFiles = [], modulesDir = process.env.NEKO_WORKBENCH_DSH_MODULES }) {
  if (!agent?.ctx?.inject || !modulesDir) throw Error('只读养鱼工具隔离不可用')
  const { NativeToolExecutor } = await import(pathToFileURL(path.join(modulesDir,'dsh-tool-executor-native/lib/index.js')).href)
  const guard=readingGuard({cwd,files,readOnlyFiles})
  let ready=false
  const fiber=agent.ctx.inject(['tools'],scope=>{
    if(!scope.tools?.restrict||!scope.tools?.guard||!scope.tools?.setExecutor)throw Error('只读养鱼工具隔离不可用')
    scope.tools.restrict({allow:['read','write','edit']})
    scope.tools.setExecutor(new NativeToolExecutor(scope))
    scope.tools.guard(guard)
    ready=true
  })
  try{await fiber;if(!ready||fiber.state!==2)throw Error()}catch{await fiber?.dispose?.();throw Error('只读养鱼工具隔离不可用')}
  return fiber
}

// Listener turns may run while settings change. Check authorization at every
// tool call, not only when enqueuing the turn or inside the bundled CLI.
export async function createListeningScope(agent, { cwd, files, isWriteAllowed }) {
  if (!agent?.ctx?.inject || typeof isWriteAllowed !== 'function') throw Error('养鱼监听工具隔离不可用')
  const guard=readingGuard({cwd,files})
  let ready=false
  const fiber=agent.ctx.inject(['tools'],scope=>{
    if(typeof scope.tools?.guard!=='function')throw Error('养鱼监听工具隔离不可用')
    scope.tools.guard(exec=>{
      let allowed=false
      try { allowed=isWriteAllowed()===true } catch { /* fail closed */ }
      return allowed ? undefined : guard(exec)
    })
    ready=true
  })
  try { await fiber; if(!ready||fiber.state!==2)throw Error() }
  catch { await fiber?.dispose?.(); throw Error('养鱼监听工具隔离不可用') }
  return fiber
}
