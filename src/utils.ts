// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventMap = Record<string, (...args: any[]) => void>

export class EventEmitter<T extends EventMap> {
  private listeners = new Map<keyof T, Set<T[keyof T]>>()

  on<K extends keyof T>(event: K, listener: T[K]) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(listener)
    return this
  }

  off<K extends keyof T>(event: K, listener: T[K]) {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  protected emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>) {
    const eventListeners = this.listeners.get(event)
    if (eventListeners) {
      eventListeners.forEach((listener) => {
        ;(listener as (...args: Parameters<T[K]>) => void)(...args)
      })
    }
  }
}

export const encodeUpdate = (update: Uint8Array): string => {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < update.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(update.subarray(i, i + chunkSize)))
  }
  return btoa(binary)
}

export const decodeUpdate = (encoded: string): Uint8Array => {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
