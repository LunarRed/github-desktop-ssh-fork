const groupByMachineKey = 'repositoriesGroupByMachine'

/**
 * Whether the repository selector should be grouped by the physical machine
 * the working copy lives on (i.e. `machine | org | repo` instead of
 * `org | repo`). Defaults to false.
 */
export function getGroupRepositoriesByMachine(): boolean {
  return localStorage.getItem(groupByMachineKey) === '1'
}

export function setGroupRepositoriesByMachine(value: boolean): void {
  localStorage.setItem(groupByMachineKey, value ? '1' : '0')
}
