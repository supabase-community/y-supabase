import type { SupabaseClient } from '@supabase/supabase-js'
import * as Y from 'yjs'
import { EventEmitter, encodeUpdate, decodeUpdate } from './utils'

export type SupabasePersistenceOptions = {
  /** Table name to store document state. Default: 'yjs_documents' */
  table?: string
  /** Schema name. Default: 'public' */
  schema?: string
  /** Column name for the room/document identifier. Default: 'room' */
  roomColumn?: string
  /** Column name for the binary state. Default: 'state' */
  stateColumn?: string
  /** Debounce timeout in ms before persisting updates. Default: 1000 */
  storeTimeout?: number
}

type PersistenceEventMap = {
  synced: (persistence: SupabasePersistence) => void
  error: (error: Error) => void
}

const DEFAULT_TABLE = 'yjs_documents'
const DEFAULT_SCHEMA = 'public'
const DEFAULT_ROOM_COLUMN = 'room'
const DEFAULT_STATE_COLUMN = 'state'
const DEFAULT_STORE_TIMEOUT = 1000

export class SupabasePersistence extends EventEmitter<PersistenceEventMap> {
  doc: Y.Doc
  name: string
  synced: boolean = false

  private supabase: SupabaseClient
  private table: string
  private schema: string
  private roomColumn: string
  private stateColumn: string
  private storeTimeout: number
  private storeTimeoutId: ReturnType<typeof setTimeout> | null = null
  private destroyed: boolean = false
  private _storeUpdate: (update: Uint8Array, origin: unknown) => void
  private _onDocDestroy: () => void

  constructor(name: string, doc: Y.Doc, supabase: SupabaseClient, options?: SupabasePersistenceOptions) {
    super()
    this.doc = doc
    this.name = name
    this.supabase = supabase
    this.table = options?.table ?? DEFAULT_TABLE
    this.schema = options?.schema ?? DEFAULT_SCHEMA
    this.roomColumn = options?.roomColumn ?? DEFAULT_ROOM_COLUMN
    this.stateColumn = options?.stateColumn ?? DEFAULT_STATE_COLUMN
    this.storeTimeout = options?.storeTimeout ?? DEFAULT_STORE_TIMEOUT

    this._storeUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin !== this && !this.destroyed) {
        if (this.storeTimeoutId !== null) {
          clearTimeout(this.storeTimeoutId)
        }
        this.storeTimeoutId = setTimeout(() => {
          this.storeTimeoutId = null
          this.storeState().catch((err) => {
            this.emit('error', err instanceof Error ? err : new Error('Failed to persist state'))
          })
        }, this.storeTimeout)
      }
    }

    doc.on('update', this._storeUpdate)
    this.destroy = this.destroy.bind(this)
    this._onDocDestroy = () => {
      this.destroy().catch((err) => {
        this.emit('error', err instanceof Error ? err : new Error('Failed to flush state on destroy'))
      })
    }
    doc.on('destroy', this._onDocDestroy)

    this.fetchAndApply()
  }

  private async fetchAndApply() {
    try {
      const { data, error } = await this.supabase
        .schema(this.schema)
        .from(this.table)
        .select(this.stateColumn)
        .eq(this.roomColumn, this.name)
        .single()

      if (error) {
        // PGRST116 = "no rows returned" from .single() — not an error, just no persisted state yet
        if (error.code !== 'PGRST116') {
          this.emit('error', new Error(`Failed to fetch persisted state: ${error.message}`))
        }
      } else if (!this.destroyed && data) {
        const state = (data as unknown as Record<string, string>)[this.stateColumn]
        if (state) {
          const update = decodeUpdate(state)
          Y.applyUpdate(this.doc, update, this)
        }
      }

      // Persist current doc state (merges local + loaded state)
      if (!this.destroyed) {
        await this.storeState()
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error('Failed to fetch persisted state'))
    }

    if (!this.destroyed) {
      this.synced = true
      this.emit('synced', this)
    }
  }

  private async storeState() {
    const state = Y.encodeStateAsUpdate(this.doc)
    const encoded = encodeUpdate(state)

    const { error } = await this.supabase
      .schema(this.schema)
      .from(this.table)
      .upsert(
        {
          [this.roomColumn]: this.name,
          [this.stateColumn]: encoded,
        },
        { onConflict: this.roomColumn }
      )

    if (error) {
      throw new Error(`Failed to persist state: ${error.message}`)
    }
  }

  async destroy() {
    const hasPendingWrite = this.storeTimeoutId !== null
    if (hasPendingWrite) {
      clearTimeout(this.storeTimeoutId!)
      this.storeTimeoutId = null
    }
    this.doc.off('update', this._storeUpdate)
    this.doc.off('destroy', this._onDocDestroy)
    this.destroyed = true
    if (hasPendingWrite) {
      await this.storeState()
    }
  }

  async clearData() {
    await this.destroy()
    const { error } = await this.supabase
      .schema(this.schema)
      .from(this.table)
      .delete()
      .eq(this.roomColumn, this.name)

    if (error) {
      throw new Error(`Failed to clear persisted data: ${error.message}`)
    }
  }
}
