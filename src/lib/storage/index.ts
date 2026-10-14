export class StorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageError'
  }
}

function getLocalStorage(): chrome.storage.LocalStorageArea {
  if (!chrome?.storage?.local) {
    throw new StorageError('chrome.storage.local is not available')
  }
  return chrome.storage.local
}

export const persistentStorage = {
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const result = await getLocalStorage().get(key)
      return result[key] as T | undefined
    } catch (e) {
      throw new StorageError(`get("${key}") failed: ${(e as Error).message}`)
    }
  },

  async getMany<T extends Record<string, unknown>>(keys: readonly string[]): Promise<Partial<T>> {
    try {
      return (await getLocalStorage().get([...keys])) as Partial<T>
    } catch (e) {
      throw new StorageError(`getMany() failed: ${(e as Error).message}`)
    }
  },

  async set<T>(key: string, value: T): Promise<void> {
    try {
      await getLocalStorage().set({ [key]: value })
    } catch (e) {
      throw new StorageError(`set("${key}") failed: ${(e as Error).message}`)
    }
  },

  async setMany(items: Record<string, unknown>): Promise<void> {
    try {
      await getLocalStorage().set(items)
    } catch (e) {
      throw new StorageError(`setMany() failed: ${(e as Error).message}`)
    }
  },

  async remove(key: string | ReadonlyArray<string>): Promise<void> {
    try {
      const keys = Array.isArray(key) ? [...key] : key
      await getLocalStorage().remove(keys as string | string[])
    } catch (e) {
      throw new StorageError(`remove("${String(key)}") failed: ${(e as Error).message}`)
    }
  },

  async clear(): Promise<void> {
    try {
      await getLocalStorage().clear()
    } catch (e) {
      throw new StorageError(`clear() failed: ${(e as Error).message}`)
    }
  },

  onChanged(
    listener: (changes: Record<string, chrome.storage.StorageChange>, areaName: 'local') => void,
  ): void {
    if (!chrome?.storage?.onChanged) return
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        listener(changes, 'local')
      }
    })
  },
}

export const configStore = {
  async get<T>(): Promise<T | undefined> {
    return persistentStorage.get<T>('_veloConfig')
  },
  async set<T>(value: T): Promise<void> {
    return persistentStorage.set('_veloConfig', value)
  },
}

export const settingsStore = {
  async get<T>(): Promise<T | undefined> {
    return persistentStorage.get<T>('_adclearSettings')
  },
  async set<T>(value: T): Promise<void> {
    return persistentStorage.set('_adclearSettings', value)
  },
}