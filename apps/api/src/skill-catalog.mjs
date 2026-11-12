import { readFile, realpath, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const catalogFile = new URL('../../../skills/catalog/catalog.json', import.meta.url)
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const verified = new Map()

async function localPackage(root, path) {
  if (
    typeof path !== 'string' ||
    !/^skills\/packages\/[^\\:\x00-\x1f]+\.zip$/.test(path) ||
    path.split('/').some((part) => part === '..' || part === '.')
  )
    return { error: '技能包路径无效，请管理员核对目录。' }
  try {
    const allowed = await realpath(resolve(root, 'skills/packages'))
    const target = await realpath(resolve(root, path))
    if (!target.startsWith(allowed + sep)) return { error: '技能包路径无效，请管理员核对目录。' }
    const info = await stat(target)
    if (!info.isFile() || info.size > 64 * 1024 * 1024)
      return { error: '技能包大小或格式无效，请管理员恢复原始安装包。' }
    const signature = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
    let entry = verified.get(target)
    if (entry?.signature !== signature) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(target)) hash.update(chunk)
      entry = { signature, sha256: hash.digest('hex') }
      if (verified.size >= 256) verified.clear()
      verified.set(target, entry)
    }
    return entry
  } catch (err) {
    return {
      error:
        err.code === 'ENOENT'
          ? '本机缺少技能安装包，请管理员恢复对应 ZIP 后刷新页面；也可上传自己的技能文件。'
          : '无法读取本机技能包，请管理员检查文件权限。',
    }
  }
}

/** Read-only download directory. No installation or skill code execution. */
export async function readSkillCatalog({ root = projectRoot, catalog: supplied } = {}) {
  const catalog = supplied ?? JSON.parse(await readFile(catalogFile, 'utf8'))
  const local = new Map()
  for (const { download } of catalog.items) {
    if (download.status === 'downloaded' && !local.has(download.packagePath))
      local.set(download.packagePath, await localPackage(root, download.packagePath))
  }
  return {
    generatedAt: catalog.generatedAt,
    curation: catalog.curation,
    items: catalog.items.map(
      ({
        id,
        number,
        category,
        name,
        descriptionZh,
        descriptionEn,
        source,
        sameNameCount,
        detailUrl,
        descriptionBasis,
        download,
        defaultHidden,
        mergedSources,
      }) => ({
        id,
        defaultHidden: !!defaultHidden,
        mergedSources: mergedSources || [],
        number,
        category,
        name,
        descriptionZh,
        descriptionEn,
        source,
        sameNameCount,
        detailUrl,
        descriptionBasis,
        download: {
          status:
            download.status === 'downloaded' &&
            !local.get(download.packagePath)?.error &&
            local.get(download.packagePath)?.sha256 === download.sha256
              ? 'downloaded'
              : 'failed',
          packagePath: download.packagePath,
          skillFile: download.skillFile,
          sha256: download.sha256,
          packageBytes: download.packageBytes,
          historical: download.historical || false,
          error:
            download.status === 'failed'
              ? '技能来源暂不可用或未能对应原文'
              : local.get(download.packagePath)?.error ||
                (local.get(download.packagePath)?.sha256 !== download.sha256
                  ? '本机技能包校验失败，请管理员恢复原始安装包后刷新页面。'
                  : undefined),
        },
      }),
    ),
  }
}
