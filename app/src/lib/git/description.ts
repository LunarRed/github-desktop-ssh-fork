import { fileSystemFor } from '../repository-file-system'

const GitDescriptionPath = '.git/description'

export const DefaultGitDescription =
  "Unnamed repository; edit this file 'description' to name the repository.\n"

/** Get the repository's description from the .git/description file. */
export async function getGitDescription(
  repositoryPath: string
): Promise<string> {
  try {
    const data = await fileSystemFor(repositoryPath).readFile(
      GitDescriptionPath,
      'utf8'
    )
    if (data === DefaultGitDescription) {
      return ''
    }
    return data
  } catch (err) {
    return ''
  }
}

/** Write a .git/description file to the repository. */
export async function writeGitDescription(
  repositoryPath: string,
  description: string
): Promise<void> {
  await fileSystemFor(repositoryPath).writeFile(GitDescriptionPath, description)
}
