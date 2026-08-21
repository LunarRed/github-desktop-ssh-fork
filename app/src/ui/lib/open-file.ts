import { shell } from '../../lib/app-shell'
import { fileSystemFor } from '../../lib/repository-file-system'
import { Dispatcher } from '../dispatcher'

export async function openFile(
  fullPath: string,
  dispatcher: Dispatcher
): Promise<void> {
  if (!fileSystemFor(fullPath).capabilities.defaultProgram) {
    await dispatcher.openInExternalEditor(fullPath)
    return
  }

  const result = await shell.openExternal(`file://${fullPath}`)

  if (!result) {
    const error = {
      name: 'no-external-program',
      message: `Unable to open file ${fullPath} in an external program. Please check you have a program associated with this file extension`,
    }
    await dispatcher.postError(error)
  }
}
