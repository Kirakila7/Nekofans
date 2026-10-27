/**
 * Embed the five builtin chibi portraits into lib/client.js.
 *
 *   node scripts/embed-avatars.mjs <folder>            # yui.webp devcat.webp bigfish.webp claude.webp gemini.webp
 *   node scripts/embed-avatars.mjs --manifest m.json   # { "yui": "path/a.webp", ... } (paths relative to the json)
 *   node scripts/embed-avatars.mjs --reset             # back to the SVG placeholders
 *   add --bundle <path> to target another client.js, --dry-run to validate only
 *
 * Only the block between "// @neko-avatars:start" and "// @neko-avatars:end"
 * is rewritten. Files must be real WebP or PNG (magic bytes checked), each
 * <= 200 KB. Missing ids are an error: all five or nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const IDS = ['yui', 'devcat', 'bigfish', 'claude', 'gemini']
export const MAX_BYTES = 200 * 1024
const START = '// @neko-avatars:start'
const END = '// @neko-avatars:end'

const here = dirname(fileURLToPath(import.meta.url))
const defaultBundle = join(here, '..', 'lib', 'client.js')

/** Returns the MIME type for supported raster bytes, or throws. */
export function sniff(bytes, label) {
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  throw new Error(`${label}: not a WebP or PNG file`)
}

/** Builds the replacement block for a { id: Buffer } map (or null to reset). */
export function avatarBlock(images) {
  if (!images) return `${START}\n    const AVATAR_ART = Object.freeze({})\n    ${END}`
  const lines = IDS.map((id) => {
    const bytes = images[id]
    if (!bytes) throw new Error(`missing avatar: ${id}`)
    if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error(`${id}: ${bytes.length} bytes, limit is ${MAX_BYTES}`)
    const mime = sniff(bytes, id)
    return `      ${id}: 'data:${mime};base64,${bytes.toString('base64')}',`
  })
  return `${START}\n    const AVATAR_ART = Object.freeze({\n${lines.join('\n')}\n    })\n    ${END}`
}

/** Replaces exactly one marker block in the bundle source. */
export function embed(source, block) {
  const start = source.indexOf(START)
  const end = source.indexOf(END)
  if (start < 0 || end < start || source.indexOf(START, start + 1) >= 0) {
    throw new Error('bundle must contain exactly one @neko-avatars:start/end block')
  }
  return source.slice(0, start) + block + source.slice(end + END.length)
}

function loadImages(args) {
  const mi = args.indexOf('--manifest')
  if (mi >= 0) {
    const file = resolve(args[mi + 1] || '')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    const extra = Object.keys(manifest).filter((k) => !IDS.includes(k))
    if (extra.length) throw new Error(`unknown ids in manifest: ${extra.join(', ')}`)
    return Object.fromEntries(IDS.map((id) => {
      if (typeof manifest[id] !== 'string') throw new Error(`manifest is missing ${id}`)
      return [id, readFileSync(resolve(dirname(file), manifest[id]))]
    }))
  }
  const folder = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--bundle')
  if (!folder) throw new Error('usage: embed-avatars.mjs <folder> | --manifest m.json | --reset [--bundle path] [--dry-run]')
  return Object.fromEntries(IDS.map((id) => [id, readFileSync(join(resolve(folder), `${id}.webp`))]))
}

function main(args) {
  const bi = args.indexOf('--bundle')
  const bundle = bi >= 0 ? resolve(args[bi + 1]) : defaultBundle
  const images = args.includes('--reset') ? null : loadImages(args)
  const next = embed(readFileSync(bundle, 'utf8'), avatarBlock(images))
  if (args.includes('--dry-run')) {
    console.log(`ok (dry run): ${images ? 'five avatars valid' : 'reset block valid'}`)
    return
  }
  writeFileSync(bundle, next)
  console.log(images ? `embedded ${IDS.length} avatars into ${bundle}` : `reset avatars in ${bundle}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`embed-avatars: ${error.message}`)
    process.exit(1)
  }
}
