import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { SupabasePersistence } from '../src/SupabasePersistence'
import { encodeUpdate } from '../src/utils'

// Mock Supabase client that simulates PostgREST behavior
const createMockSupabase = () => {
  const store = new Map<string, Record<string, string>>()

  const createQueryBuilder = (schemaName = 'public') => {
    let tableName = ''
    let selectedColumn = '*'
    let filterColumn = ''
    let filterValue = ''

    const builder = {
      from(table: string) {
        tableName = table
        return builder
      },
      select(column: string) {
        selectedColumn = column
        return builder
      },
      eq(column: string, value: string) {
        filterColumn = column
        filterValue = value
        return builder
      },
      single() {
        const key = `${schemaName}.${tableName}`
        const rows = store.get(key)

        if (!rows || !rows[filterValue]) {
          return Promise.resolve({
            data: null,
            error: { code: 'PGRST116', message: 'No rows found' },
          })
        }

        return Promise.resolve({
          data: { [filterColumn]: filterValue, [selectedColumn]: rows[filterValue] },
          error: null,
        })
      },
      upsert(row: Record<string, string>, _options?: { onConflict: string }) {
        const key = `${schemaName}.${tableName}`
        if (!store.has(key)) {
          store.set(key, {})
        }
        const roomCol = Object.keys(row).find((k) => k !== selectedColumn) || Object.keys(row)[0]
        const stateCol = Object.keys(row).find((k) => k !== roomCol) || Object.keys(row)[1]
        store.get(key)![row[roomCol]] = row[stateCol]
        return Promise.resolve({ error: null })
      },
      delete() {
        return {
          eq(column: string, value: string) {
            const key = `${schemaName}.${tableName}`
            const rows = store.get(key)
            if (rows) {
              delete rows[value]
            }
            return Promise.resolve({ error: null })
          },
        }
      },
    }

    return builder
  }

  const mockSupabase = {
    schema(name: string) {
      return createQueryBuilder(name)
    },
    _store: store,
    _reset() {
      store.clear()
    },
  }

  return mockSupabase
}

// Helper to seed the mock store with persisted state
const seedState = (
  mockSupabase: ReturnType<typeof createMockSupabase>,
  roomName: string,
  doc: Y.Doc,
  options?: { schema?: string; table?: string }
) => {
  const schema = options?.schema ?? 'public'
  const table = options?.table ?? 'yjs_documents'
  const key = `${schema}.${table}`
  if (!mockSupabase._store.has(key)) {
    mockSupabase._store.set(key, {})
  }
  const state = Y.encodeStateAsUpdate(doc)
  mockSupabase._store.get(key)![roomName] = encodeUpdate(state)
}

describe('SupabasePersistence', () => {
  let doc: Y.Doc
  let mockSupabase: ReturnType<typeof createMockSupabase>

  beforeEach(() => {
    doc = new Y.Doc()
    mockSupabase = createMockSupabase()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('constructor', () => {
    it('should create a persistence instance with required parameters', () => {
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)

      expect(persistence).toBeInstanceOf(SupabasePersistence)
      expect(persistence.doc).toBe(doc)
      expect(persistence.name).toBe('test-room')
      expect(persistence.synced).toBe(false)
    })

    it('should emit synced event after initialization', async () => {
      const syncedHandler = vi.fn()
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)
      persistence.on('synced', syncedHandler)

      await vi.runAllTimersAsync()

      expect(syncedHandler).toHaveBeenCalledWith(persistence)
      expect(persistence.synced).toBe(true)
    })

    it('should support method chaining on on/off', () => {
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)
      const handler = vi.fn()

      const result = persistence.on('synced', handler)
      expect(result).toBe(persistence)

      const result2 = persistence.off('synced', handler)
      expect(result2).toBe(persistence)
    })
  })

  describe('loading persisted state', () => {
    it('should apply persisted state from Supabase on init', async () => {
      // Create a doc with content and seed it
      const sourceDoc = new Y.Doc()
      sourceDoc.getText('test').insert(0, 'persisted content')
      seedState(mockSupabase, 'test-room', sourceDoc)

      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      expect(persistence.synced).toBe(true)
      expect(doc.getText('test').toString()).toBe('persisted content')
    })

    it('should handle no existing state gracefully', async () => {
      const errorHandler = vi.fn()
      const persistence = new SupabasePersistence('new-room', doc, mockSupabase as never)
      persistence.on('error', errorHandler)

      await vi.runAllTimersAsync()

      expect(persistence.synced).toBe(true)
      expect(errorHandler).not.toHaveBeenCalled()
    })

    it('should merge persisted state with local state', async () => {
      // Seed persisted state
      const sourceDoc = new Y.Doc()
      sourceDoc.getText('test').insert(0, 'remote')
      seedState(mockSupabase, 'test-room', sourceDoc)

      // Local doc already has content
      doc.getText('local').insert(0, 'local data')

      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      expect(doc.getText('test').toString()).toBe('remote')
      expect(doc.getText('local').toString()).toBe('local data')
      expect(persistence.synced).toBe(true)
    })
  })

  describe('persisting updates', () => {
    it('should persist state after document updates (debounced)', async () => {
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      // Make a local change
      doc.getText('test').insert(0, 'hello')

      // Should not be persisted yet (debounce)
      const key = 'public.yjs_documents'
      const stateBeforeDebounce = mockSupabase._store.get(key)?.['test-room']

      // Advance past debounce timeout
      await vi.advanceTimersByTimeAsync(1000)

      const stateAfterDebounce = mockSupabase._store.get(key)?.['test-room']
      expect(stateAfterDebounce).toBeDefined()
      expect(stateAfterDebounce).not.toBe(stateBeforeDebounce)

      await persistence.destroy()
    })

    it('should debounce multiple rapid updates', async () => {
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never, {
        storeTimeout: 500,
      })

      await vi.runAllTimersAsync()

      // Make multiple rapid changes
      doc.getText('test').insert(0, 'a')
      doc.getText('test').insert(1, 'b')
      doc.getText('test').insert(2, 'c')

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(500)

      // Verify final state is persisted
      const key = 'public.yjs_documents'
      const stored = mockSupabase._store.get(key)?.['test-room']
      expect(stored).toBeDefined()

      // Decode and verify
      const restoredDoc = new Y.Doc()
      const { decodeUpdate } = await import('../src/utils')
      Y.applyUpdate(restoredDoc, decodeUpdate(stored!))
      expect(restoredDoc.getText('test').toString()).toBe('abc')

      await persistence.destroy()
    })

    it('should not persist updates originating from persistence itself', async () => {
      // Seed existing state so fetchAndApply applies an update with origin=this
      const sourceDoc = new Y.Doc()
      sourceDoc.getText('test').insert(0, 'seeded')
      seedState(mockSupabase, 'test-room', sourceDoc)

      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      // The debounce timer should NOT have been triggered by the fetchAndApply update
      // (only the initial storeState in fetchAndApply should have written)
      expect(vi.getTimerCount()).toBe(0)

      await persistence.destroy()
    })

    it('should respect custom storeTimeout', async () => {
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never, {
        storeTimeout: 2000,
      })

      await vi.runAllTimersAsync()

      doc.getText('test').insert(0, 'hello')

      // Advance 1s — should NOT have persisted yet
      await vi.advanceTimersByTimeAsync(1000)

      const key = 'public.yjs_documents'
      const stateAt1s = mockSupabase._store.get(key)?.['test-room']

      // Advance another 1s (total 2s) — should persist now
      await vi.advanceTimersByTimeAsync(1000)

      const stateAt2s = mockSupabase._store.get(key)?.['test-room']
      expect(stateAt2s).toBeDefined()
      expect(stateAt2s).not.toBe(stateAt1s)

      await persistence.destroy()
    })
  })

  describe('custom options', () => {
    it('should use custom table and column names', async () => {
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never, {
        table: 'custom_docs',
        schema: 'app',
        roomColumn: 'doc_id',
        stateColumn: 'doc_state',
      })

      await vi.runAllTimersAsync()

      // The initial storeState should have written to custom location
      const key = 'app.custom_docs'
      expect(mockSupabase._store.has(key)).toBe(true)

      await persistence.destroy()
    })
  })

  describe('destroy', () => {
    it('should stop listening to document updates after destroy', async () => {
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      await persistence.destroy()

      // Make a change after destroy
      doc.getText('test').insert(0, 'after destroy')

      // Advance timers — no debounced persist should fire
      await vi.advanceTimersByTimeAsync(2000)

      expect(vi.getTimerCount()).toBe(0)
    })

    it('should flush pending writes on destroy', async () => {
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      // Make a change (starts debounce timer)
      doc.getText('test').insert(0, 'pending data')

      // Destroy before debounce fires
      await persistence.destroy()

      // Verify state was flushed
      const key = 'public.yjs_documents'
      const stored = mockSupabase._store.get(key)?.['test-room']
      expect(stored).toBeDefined()

      const restoredDoc = new Y.Doc()
      const { decodeUpdate } = await import('../src/utils')
      Y.applyUpdate(restoredDoc, decodeUpdate(stored!))
      expect(restoredDoc.getText('test').toString()).toBe('pending data')
    })

    it('should auto-destroy when doc is destroyed', async () => {
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)

      await vi.runAllTimersAsync()
      expect(persistence.synced).toBe(true)

      doc.destroy()

      // After doc destroy, persistence should no longer listen
      // Creating a new doc and making changes shouldn't trigger persistence
      expect(vi.getTimerCount()).toBe(0)
    })

    it('should emit error if flush fails during doc.destroy()', async () => {
      let upsertCallCount = 0
      const failOnFlush = {
        schema() {
          return {
            from() {
              return {
                select() {
                  return {
                    eq() {
                      return {
                        single() {
                          return Promise.resolve({
                            data: null,
                            error: { code: 'PGRST116', message: 'No rows found' },
                          })
                        },
                      }
                    },
                  }
                },
                upsert() {
                  upsertCallCount++
                  if (upsertCallCount > 1) {
                    return Promise.resolve({
                      error: { message: 'connection refused' },
                    })
                  }
                  return Promise.resolve({ error: null })
                },
              }
            },
          }
        },
      }

      const errorHandler = vi.fn()
      const persistence = new SupabasePersistence('test-room', doc, failOnFlush as never)
      persistence.on('error', errorHandler)

      await vi.runAllTimersAsync()

      // Make a change to create a pending write
      doc.getText('test').insert(0, 'data')

      // doc.destroy() triggers the _onDocDestroy wrapper which catches and emits
      doc.destroy()
      await vi.runAllTimersAsync()

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('connection refused'),
        })
      )
    })

    it('should not fail if destroyed twice', async () => {
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      await persistence.destroy()
      await expect(persistence.destroy()).resolves.not.toThrow()
    })
  })

  describe('clearData', () => {
    it('should remove persisted data from Supabase', async () => {
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      // Verify state was persisted
      const key = 'public.yjs_documents'
      expect(mockSupabase._store.get(key)?.['test-room']).toBeDefined()

      await persistence.clearData()

      expect(mockSupabase._store.get(key)?.['test-room']).toBeUndefined()
    })

    it('should also destroy the persistence instance', async () => {
      const persistence = new SupabasePersistence('test-room', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      await persistence.clearData()

      // Should no longer react to doc updates
      doc.getText('test').insert(0, 'after clear')
      await vi.advanceTimersByTimeAsync(2000)

      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('error handling', () => {
    it('should emit error on Supabase fetch failure', async () => {
      // Override schema to return an error
      const failingSupabase = {
        schema() {
          return {
            from() {
              return {
                select() {
                  return {
                    eq() {
                      return {
                        single() {
                          return Promise.resolve({
                            data: null,
                            error: { code: '42P01', message: 'relation does not exist' },
                          })
                        },
                      }
                    },
                  }
                },
                upsert() {
                  return Promise.resolve({ error: null })
                },
              }
            },
          }
        },
      }

      const errorHandler = vi.fn()
      const persistence = new SupabasePersistence('test-room', doc, failingSupabase as never)
      persistence.on('error', errorHandler)

      await vi.runAllTimersAsync()

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('relation does not exist'),
        })
      )

      // Should still emit synced even after error
      expect(persistence.synced).toBe(true)
    })

    it('should emit error on Supabase upsert failure during debounced write', async () => {
      let upsertCallCount = 0
      const failOnSecondUpsert = {
        schema() {
          return {
            from() {
              return {
                select() {
                  return {
                    eq() {
                      return {
                        single() {
                          return Promise.resolve({
                            data: null,
                            error: { code: 'PGRST116', message: 'No rows found' },
                          })
                        },
                      }
                    },
                  }
                },
                upsert() {
                  upsertCallCount++
                  if (upsertCallCount > 1) {
                    return Promise.resolve({
                      error: { message: 'permission denied' },
                    })
                  }
                  return Promise.resolve({ error: null })
                },
              }
            },
          }
        },
      }

      const errorHandler = vi.fn()
      const persistence = new SupabasePersistence('test-room', doc, failOnSecondUpsert as never)
      persistence.on('error', errorHandler)

      await vi.runAllTimersAsync()

      // Make a change to trigger debounced write
      doc.getText('test').insert(0, 'hello')

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(1000)

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('permission denied'),
        })
      )

      await persistence.destroy()
    })

    it('should not emit error for PGRST116 (no rows found)', async () => {
      const errorHandler = vi.fn()
      const persistence = new SupabasePersistence('new-room', doc, mockSupabase as never)
      persistence.on('error', errorHandler)

      await vi.runAllTimersAsync()

      expect(errorHandler).not.toHaveBeenCalled()
      expect(persistence.synced).toBe(true)
    })
  })

  describe('real-world persistence scenarios', () => {
    it('should persist and restore a document across instances', async () => {
      // First instance creates content
      const doc1 = new Y.Doc()
      const persistence1 = new SupabasePersistence('shared-doc', doc1, mockSupabase as never)

      await vi.runAllTimersAsync()

      doc1.getText('content').insert(0, 'Hello, world!')
      doc1.getMap('meta').set('author', 'Alice')

      await vi.advanceTimersByTimeAsync(1000)
      await persistence1.destroy()

      // Second instance loads the content
      const doc2 = new Y.Doc()
      const persistence2 = new SupabasePersistence('shared-doc', doc2, mockSupabase as never)

      await vi.runAllTimersAsync()

      expect(doc2.getText('content').toString()).toBe('Hello, world!')
      expect(doc2.getMap('meta').get('author')).toBe('Alice')

      await persistence2.destroy()
    })

    it('should handle multiple rooms independently', async () => {
      const docA = new Y.Doc()
      const docB = new Y.Doc()

      const persistA = new SupabasePersistence('room-a', docA, mockSupabase as never)
      const persistB = new SupabasePersistence('room-b', docB, mockSupabase as never)

      await vi.runAllTimersAsync()

      docA.getText('text').insert(0, 'Room A content')
      docB.getText('text').insert(0, 'Room B content')

      await vi.advanceTimersByTimeAsync(1000)
      await persistA.destroy()
      await persistB.destroy()

      // Restore each room
      const restoredA = new Y.Doc()
      const restoredB = new Y.Doc()

      const pA = new SupabasePersistence('room-a', restoredA, mockSupabase as never)
      const pB = new SupabasePersistence('room-b', restoredB, mockSupabase as never)

      await vi.runAllTimersAsync()

      expect(restoredA.getText('text').toString()).toBe('Room A content')
      expect(restoredB.getText('text').toString()).toBe('Room B content')

      await pA.destroy()
      await pB.destroy()
    })

    it('should preserve Yjs CRDT merge semantics across persist/restore', async () => {
      // Two docs make concurrent changes
      const doc1 = new Y.Doc()
      const doc2 = new Y.Doc()

      doc1.getText('text').insert(0, 'Hello')
      doc2.getText('text').insert(0, 'World')

      // Merge them
      Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2))

      // Persist the merged state
      const persistence = new SupabasePersistence('merged-doc', doc1, mockSupabase as never)
      await vi.runAllTimersAsync()
      await persistence.destroy()

      // Restore and verify merge is intact
      const restored = new Y.Doc()
      const p2 = new SupabasePersistence('merged-doc', restored, mockSupabase as never)
      await vi.runAllTimersAsync()

      const text = restored.getText('text').toString()
      // CRDT merge — both insertions should be present
      expect(text).toContain('Hello')
      expect(text).toContain('World')

      await p2.destroy()
    })
  })
})
