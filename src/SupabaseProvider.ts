import { RealtimeChannel, REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import { EventEmitter, encodeUpdate, decodeUpdate } from './utils'
import { SupabasePersistence } from './SupabasePersistence'
import type { SupabasePersistenceOptions } from './SupabasePersistence'

type SupabaseProviderOptions = {
  broadcastThrottleMs?: number
  /** Enable automatic reconnection on disconnect. Default: true */
  autoReconnect?: boolean
  /** Maximum reconnection attempts. Default: Infinity */
  maxReconnectAttempts?: number
  /** Initial reconnection delay in ms. Default: 1000 */
  reconnectDelay?: number
  /** Maximum reconnection delay in ms. Default: 30000 */
  maxReconnectDelay?: number
  /** Enable awareness for presence features. Pass true to create new instance, or pass existing Awareness */
  awareness?: boolean | Awareness
  /** Enable persistence. Pass true for defaults, or pass options to customize. */
  persistence?: boolean | SupabasePersistenceOptions
}

type Status = 'connecting' | 'connected' | 'disconnected'

type RealtimeYPayload = {
  update: string
  user: {
    id: string
  }
  timestamp: number
}

const UPDATE_EVENT = 'y-supabase-update'
const STATE_VECTOR_EVENT = 'y-supabase-state-vector'
const AWARENESS_EVENT = 'y-supabase-awareness'

type StateVectorPayload = {
  stateVector: string
  user: { id: string }
  timestamp: number
}

type ProviderEventMap = {
  message: (update: Uint8Array) => void
  awareness: (update: Uint8Array) => void
  status: (status: Status) => void
  connect: (provider: SupabaseProvider) => void
  disconnect: (provider: SupabaseProvider) => void
  error: (error: Error) => void
}

/**
 * A Yjs provider that syncs document updates through Supabase Realtime.
 *
 * This provider enables real-time collaboration by broadcasting Yjs document
 * updates to other connected clients via Supabase Realtime channels.
 *
 * @example
 * ```typescript
 * const doc = new Y.Doc()
 * const supabase = createClient(url, key)
 * const provider = new SupabaseProvider('my-room', doc, supabase)
 *
 * provider.on('connect', () => console.log('Connected'))
 * provider.on('message', (update) => console.log('Received update'))
 * ```
 */
class SupabaseProvider extends EventEmitter<ProviderEventMap> {
  private channelName: string
  private doc: Y.Doc
  private supabase: SupabaseClient
  private channel: RealtimeChannel | null = null
  private status: Status = 'connecting'
  private userId: string
  private broadcastTimeout: ReturnType<typeof setTimeout> | null = null
  private pendingUpdates: Uint8Array[] = []
  private options: SupabaseProviderOptions | undefined
  private syncedPeers = new Set<string>()
  private awareness: Awareness | null = null
  private persistence: SupabasePersistence | null = null
  private reconnectAttempts = 0
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private shouldReconnect = true
  private boundBeforeUnload: (() => void) | null = null

  constructor(channelName: string, doc: Y.Doc, supabase: SupabaseClient, options?: SupabaseProviderOptions) {
    super()
    this.channelName = channelName
    this.doc = doc
    this.supabase = supabase
    this.options = options
    this.userId = crypto.randomUUID()

    if (options?.awareness) {
      this.awareness = options.awareness instanceof Awareness ? options.awareness : new Awareness(doc)
      this.handleAwarenessUpdate = this.handleAwarenessUpdate.bind(this)
      this.awareness.on('update', this.handleAwarenessUpdate)
    }

    if (options?.persistence) {
      const persistenceOptions = typeof options.persistence === 'object' ? options.persistence : undefined
      this.persistence = new SupabasePersistence(channelName, doc, supabase, persistenceOptions)
    }

    this.handleDocUpdate = this.handleDocUpdate.bind(this)

    if (typeof window !== 'undefined') {
      this.boundBeforeUnload = () => this.destroy()
      window.addEventListener('beforeunload', this.boundBeforeUnload)
    }

    this.connect()
  }

  private setStatus(next: Status) {
    this.status = next
    this.emit('status', next)
  }

  private broadcastUpdate(update: Uint8Array, event = UPDATE_EVENT) {
    if (!this.channel) return

    const payload: RealtimeYPayload = {
      update: encodeUpdate(update),
      user: { id: this.userId },
      timestamp: Date.now(),
    }

    this.channel.send({
      type: 'broadcast',
      event,
      payload,
    })
  }

  private queueBroadcast(update: Uint8Array) {
    const throttle = this.options?.broadcastThrottleMs ?? 0

    if (throttle <= 0) {
      this.broadcastUpdate(update)
      return
    }

    this.pendingUpdates.push(update)

    if (this.broadcastTimeout) return

    this.broadcastTimeout = setTimeout(() => {
      this.broadcastTimeout = null
      if (this.pendingUpdates.length === 0) return

      const mergedUpdate =
        this.pendingUpdates.length === 1
          ? this.pendingUpdates[0]
          : Y.mergeUpdates(this.pendingUpdates)
      this.pendingUpdates = []
      this.broadcastUpdate(mergedUpdate)
    }, throttle)
  }

  private handleDocUpdate(update: Uint8Array, origin: unknown) {
    if (origin === 'remote') return

    this.queueBroadcast(update)
  }

  private handleRemoteUpdate(payload: RealtimeYPayload) {
    if (payload.user.id === this.userId) return

    try {
      const update = decodeUpdate(payload.update)
      Y.applyUpdate(this.doc, update, 'remote')
      this.emit('message', update)
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error('Failed to apply remote update'))
    }
  }

  private broadcastAwarenessUpdate(update: Uint8Array) {
    if (!this.channel) return

    const payload: RealtimeYPayload = {
      update: encodeUpdate(update),
      user: { id: this.userId },
      timestamp: Date.now(),
    }

    this.channel.send({
      type: 'broadcast',
      event: AWARENESS_EVENT,
      payload,
    })
  }

  private handleAwarenessUpdate(
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: 'remote' | Awareness | null
  ) {
    if (!this.awareness) return
    if (origin === 'remote') return

    const update = encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed])
    this.broadcastAwarenessUpdate(update)
  }

  private handleRemoteAwareness(payload: RealtimeYPayload) {
    if (!this.awareness) return
    if (payload.user.id === this.userId) return

    try {
      const update = decodeUpdate(payload.update)
      applyAwarenessUpdate(this.awareness, update, 'remote')
      this.emit('awareness', update)
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error('Failed to apply awareness update'))
    }
  }

  /**
   * Sends our state vector to request missing updates from peers.
   */
  private sendStateVector() {
    if (!this.channel) return

    const stateVector = Y.encodeStateVector(this.doc)
    const payload: StateVectorPayload = {
      stateVector: encodeUpdate(stateVector),
      user: { id: this.userId },
      timestamp: Date.now(),
    }

    this.channel.send({
      type: 'broadcast',
      event: STATE_VECTOR_EVENT,
      payload,
    })
  }

  /**
   * Handles incoming state vector from a peer.
   * Computes the diff (what the peer is missing) and sends it.
   */
  private handleStateVector(payload: StateVectorPayload) {
    if (payload.user.id === this.userId) return

    // Prevent infinite ping-pong - only sync once per peer
    if (this.syncedPeers.has(payload.user.id)) return
    this.syncedPeers.add(payload.user.id)

    try {
      const remoteStateVector = decodeUpdate(payload.stateVector)

      // Compute what the remote peer is missing based on their state vector
      const diff = Y.encodeStateAsUpdate(this.doc, remoteStateVector)

      // Only send if there's actual data (empty update is ~2 bytes)
      if (diff.length > 2) {
        this.broadcastUpdate(diff)
      }

      // Send our state vector so they can send us what we're missing
      this.sendStateVector()
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error('Failed to handle state vector'))
    }
  }

  /**
   * Connects to the Supabase Realtime channel and starts syncing.
   * Called automatically in the constructor. Can be called again to reconnect.
   */
  connect() {
    this.shouldReconnect = true
    this.doc.off('update', this.handleDocUpdate)
    this.doc.on('update', this.handleDocUpdate)
    this.syncedPeers.clear()

    this.channel = this.supabase.channel(this.channelName)

    this.channel
      .on('broadcast', { event: STATE_VECTOR_EVENT }, (data: { payload: StateVectorPayload }) => {
        this.handleStateVector(data.payload)
      })
      .on('broadcast', { event: UPDATE_EVENT }, (data: { payload: RealtimeYPayload }) => {
        this.handleRemoteUpdate(data.payload)
      })
      .on('broadcast', { event: AWARENESS_EVENT }, (data: { payload: RealtimeYPayload }) => {
        this.handleRemoteAwareness(data.payload)
      })
      .subscribe((status, err) => {
        if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
          this.setStatus('connected')
          this.emit('connect', this)
          this.reconnectAttempts = 0 // Reset reconnect attempts on successful connection

          // Broadcast initial awareness state to existing peers
          if (this.awareness) {
            const update = encodeAwarenessUpdate(
              this.awareness,
              Array.from(this.awareness.getStates().keys())
            )
            this.broadcastAwarenessUpdate(update)
          }

          // Send our state vector to request sync from existing peers
          this.sendStateVector()
        } else if (status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR) {
          this.setStatus('disconnected')
          this.emit('error', err ?? new Error('Channel error'))
          this.emit('disconnect', this)
          this.scheduleReconnect()
        } else if (status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT) {
          this.setStatus('disconnected')
          this.emit('error', new Error('Connection timed out'))
          this.emit('disconnect', this)
          this.scheduleReconnect()
        } else if (status === REALTIME_SUBSCRIBE_STATES.CLOSED) {
          this.setStatus('disconnected')
          this.emit('disconnect', this)
          this.scheduleReconnect()
        }
      })
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect() {
    const autoReconnect = this.options?.autoReconnect ?? true
    const maxAttempts = this.options?.maxReconnectAttempts ?? Infinity

    if (!autoReconnect || !this.shouldReconnect || this.reconnectAttempts >= maxAttempts) {
      return
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    const baseDelay = this.options?.reconnectDelay ?? 1000
    const maxDelay = this.options?.maxReconnectDelay ?? 30000

    // Exponential backoff: 1s, 2s, 4s, 8s
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay)

    this.reconnectAttempts++

    this.reconnectTimeout = setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect()
      }
    }, delay)
  }

  /**
   * Disconnects from the channel and cleans up all resources.
   * Call this when the provider is no longer needed to prevent memory leaks.
   */
  destroy() {
    this.shouldReconnect = false

    if (this.broadcastTimeout) {
      clearTimeout(this.broadcastTimeout)
      this.broadcastTimeout = null
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.boundBeforeUnload && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.boundBeforeUnload)
      this.boundBeforeUnload = null
    }

    this.doc.off('update', this.handleDocUpdate)

    if (this.awareness) {
      removeAwarenessStates(this.awareness, [this.doc.clientID], 'local')
      this.awareness.off('update', this.handleAwarenessUpdate)
    }

    if (this.persistence) {
      this.persistence.destroy()
      this.persistence = null
    }

    if (this.channel) {
      this.supabase.removeChannel(this.channel)
      this.channel = null
    }
  }

  /**
   * Returns the current connection status.
   * @returns The current status: 'connecting', 'connected', or 'disconnected'
   */
  getStatus() {
    return this.status
  }

  /**
   * Returns the Awareness instance if awareness was enabled.
   * @returns The Awareness instance or null if awareness is disabled
   */
  getAwareness() {
    return this.awareness
  }

  /**
   * Returns the SupabasePersistence instance if persistence was enabled.
   * @returns The SupabasePersistence instance or null if persistence is disabled
   */
  getPersistence() {
    return this.persistence
  }
}

export type { SupabaseProviderOptions }
export { SupabaseProvider }
