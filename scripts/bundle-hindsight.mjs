/** Stage Warhead's extension and real built runtime into a HindSight source checkout. */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]
if (!target || !existsSync(join(target, 'PlatformServices/CoordinatorService/ScriptingHost.swift'))) {
  throw new Error('Usage: npm run bundle:hindsight -- /path/to/HindSight (run npm run build first)')
}
if (!existsSync(join(root, 'dist/cli/extension.js'))) throw new Error('Run npm run build first')
const bundle = resolve(target, 'BundledPlugins/Warhead.vgplugin')
mkdirSync(bundle, { recursive: true })
cpSync(join(root, 'extensions/Warhead.vgplugin'), bundle, { recursive: true })
cpSync(join(root, 'dist'), join(bundle, 'runtime'), { recursive: true })
cpSync(join(root, 'LICENSE'), join(bundle, 'LICENSE'))
console.log(`Staged Warhead: MGCA (Military Grade Coding Agent) -> ${bundle}`)
