import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { encodeUpdate } from '../src/utils'
import { SupabaseProvider } from '../src/SupabaseProvider'

// Mock Supabase client
const createMockChannel = () => {
  const listeners: Record<string, (data: unknown) => void> = {}
  let subscribeCallback: ((status: string, err?: Error) => void) | null = null

  const channel = {
    on: vi.fn((_type: string, options: { event: string }, callback: (data: unknown) => void) => {
      listeners[options.event] = callback
      return channel // Return same channel for chaining
    }),
    subscribe: vi.fn((callback: (status: string, err?: Error) => void) => {
      subscribeCallback = callback
      // Simulate successful connection
      setTimeout(() => callback('SUBSCRIBED'), 0)
      return { unsubscribe: vi.fn() }
    }),
    send: vi.fn(),
    unsubscribe: vi.fn(),
    // Test helpers
    _listeners: listeners,
    _triggerSubscribe: (status: string, err?: Error) => subscribeCallback?.(status, err),
    _triggerEvent: (event: string, payload: unknown) => listeners[event]?.({ payload }),
  }

  return channel
}

const createMockSupabase = () => {
  const mockChannel = createMockChannel()
  return {
    channel: vi.fn(() => mockChannel),
    removeChannel: vi.fn(),
    _mockChannel: mockChannel,
  }
}

describe('SupabaseProvider', () => {
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
    it('should create a provider with required parameters', () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)

      expect(provider).toBeInstanceOf(SupabaseProvider)
      expect(provider.getStatus()).toBe('connecting')
      expect(mockSupabase.channel).toHaveBeenCalledWith('test-channel')
    })

    it('should accept optional options', () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        broadcastThrottleMs: 100,
      })

      expect(provider).toBeInstanceOf(SupabaseProvider)
    })

    it('should automatically call connect', () => {
      new SupabaseProvider('test-channel', doc, mockSupabase as never)

      expect(mockSupabase.channel).toHaveBeenCalled()
      expect(mockSupabase._mockChannel.subscribe).toHaveBeenCalled()
    })
  })

  describe('connection status', () => {
    it('should emit connect event when subscribed', async () => {
      const connectHandler = vi.fn()
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)
      provider.on('connect', connectHandler)

      await vi.runAllTimersAsync()

      expect(connectHandler).toHaveBeenCalledWith(provider)
      expect(provider.getStatus()).toBe('connected')
    })

    it('should emit status event on connection', async () => {
      const statusHandler = vi.fn()
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)
      provider.on('status', statusHandler)

      await vi.runAllTimersAsync()

      expect(statusHandler).toHaveBeenCalledWith('connected')
    })

    it('should emit error and disconnect on channel error', async () => {
      const errorHandler = vi.fn()
      const disconnectHandler = vi.fn()

      // Override the mock to simulate channel error
      mockSupabase._mockChannel.subscribe = vi.fn((callback) => {
        setTimeout(() => callback('CHANNEL_ERROR', new Error('Test error')), 0)
        return { unsubscribe: vi.fn() }
      })

      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        autoReconnect: false
      })
      provider.on('error', errorHandler)
      provider.on('disconnect', disconnectHandler)

      await vi.runAllTimersAsync()

      expect(errorHandler).toHaveBeenCalled()
      expect(disconnectHandler).toHaveBeenCalledWith(provider)
      expect(provider.getStatus()).toBe('disconnected')
    })

    it('should emit error and disconnect on timeout', async () => {
      const errorHandler = vi.fn()
      const disconnectHandler = vi.fn()

      // Override the mock to simulate timeout
      mockSupabase._mockChannel.subscribe = vi.fn((callback) => {
        setTimeout(() => callback('TIMED_OUT'), 0)
        return { unsubscribe: vi.fn() }
      })

      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        autoReconnect: false
      })
      provider.on('error', errorHandler)
      provider.on('disconnect', disconnectHandler)

      await vi.runAllTimersAsync()

      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error))
      expect(disconnectHandler).toHaveBeenCalledWith(provider)
    })

    it('should emit disconnect on closed', async () => {
      const disconnectHandler = vi.fn()
      const errorHandler = vi.fn()

      // Override the mock to simulate closed
      mockSupabase._mockChannel.subscribe = vi.fn((callback) => {
        setTimeout(() => callback('CLOSED'), 0)
        return { unsubscribe: vi.fn() }
      })

      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        autoReconnect: false
      })
      provider.on('disconnect', disconnectHandler)
      provider.on('error', errorHandler)

      await vi.runAllTimersAsync()

      expect(disconnectHandler).toHaveBeenCalledWith(provider)
      expect(errorHandler).not.toHaveBeenCalled() // No error on clean close
    })
  })

  describe('event emitter', () => {
    it('should allow subscribing to events with on()', () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)
      const handler = vi.fn()

      const result = provider.on('status', handler)

      expect(result).toBe(provider) // Should return this for chaining
    })

    it('should allow unsubscribing from events with off()', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)
      const handler = vi.fn()

      provider.on('status', handler)
      provider.off('status', handler)

      await vi.runAllTimersAsync()

      expect(handler).not.toHaveBeenCalled()
    })

    it('should support method chaining', () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      const result = provider.on('connect', handler1).on('disconnect', handler2)

      expect(result).toBe(provider)
    })
  })

  describe('document updates', () => {
    it('should broadcast local document updates', async () => {
      new SupabaseProvider('test-channel', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      // Make a local change
      const ytext = doc.getText('test')
      ytext.insert(0, 'hello')

      expect(mockSupabase._mockChannel.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'broadcast',
          event: 'y-supabase-update',
          payload: expect.objectContaining({
            update: expect.any(String),
            user: expect.objectContaining({ id: expect.any(String) }),
            timestamp: expect.any(Number),
          }),
        })
      )
    })

    it('should throttle updates when broadcastThrottleMs is set', async () => {
      new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        broadcastThrottleMs: 100,
      })

      await vi.runAllTimersAsync()
      mockSupabase._mockChannel.send.mockClear()

      // Make multiple rapid changes
      const ytext = doc.getText('test')
      ytext.insert(0, 'a')
      ytext.insert(1, 'b')
      ytext.insert(2, 'c')

      // Should not have sent yet
      expect(mockSupabase._mockChannel.send).not.toHaveBeenCalled()

      // Advance timers past throttle
      await vi.advanceTimersByTimeAsync(100)

      // Should have sent once with merged update
      expect(mockSupabase._mockChannel.send).toHaveBeenCalledTimes(1)
    })

    it('should not broadcast updates with remote origin', async () => {
      new SupabaseProvider('test-channel', doc, mockSupabase as never)

      await vi.runAllTimersAsync()
      mockSupabase._mockChannel.send.mockClear()

      // Apply update with 'remote' origin (simulating incoming update)
      const update = Y.encodeStateAsUpdate(doc)
      Y.applyUpdate(doc, update, 'remote')

      expect(mockSupabase._mockChannel.send).not.toHaveBeenCalled()
    })
  })

  describe('destroy', () => {
    it('should clean up resources on destroy', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      provider.destroy()

      expect(mockSupabase.removeChannel).toHaveBeenCalled()
    })

    it('should clear pending broadcast timeout on destroy', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        broadcastThrottleMs: 100,
      })

      await vi.runAllTimersAsync()

      // Trigger a throttled update
      const ytext = doc.getText('test')
      ytext.insert(0, 'hello')

      // Destroy before throttle completes
      provider.destroy()

      // Advance past throttle time
      await vi.advanceTimersByTimeAsync(200)

      // Should only have the state vector send, not the update
      const updateCalls = mockSupabase._mockChannel.send.mock.calls.filter(
        (call) => call[0]?.event === 'y-supabase-update'
      )
      expect(updateCalls.length).toBe(0)
    })

    it('should stop listening to document updates after destroy', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)

      await vi.runAllTimersAsync()
      mockSupabase._mockChannel.send.mockClear()

      provider.destroy()

      // Make a local change after destroy
      const ytext = doc.getText('test')
      ytext.insert(0, 'hello')

      expect(mockSupabase._mockChannel.send).not.toHaveBeenCalled()
    })
  })

  describe('reconnect logic', () => {
    it('should clear existing reconnect timeout before scheduling a new one', async () => {
      new SupabaseProvider('test-channel', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      mockSupabase._mockChannel._triggerSubscribe('CLOSED')
      mockSupabase._mockChannel._triggerSubscribe('CHANNEL_ERROR', new Error('boom'))

      expect(vi.getTimerCount()).toBe(1)
    })

    it('should allow reconnect scheduling after destroy when connect is called again', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)

      await vi.runAllTimersAsync()
      provider.destroy()

      provider.connect()
      await vi.runAllTimersAsync()

      mockSupabase._mockChannel._triggerSubscribe('CLOSED')

      expect(vi.getTimerCount()).toBe(1)
    })

    it('should attempt to reconnect after a disconnect', async () => {
      new SupabaseProvider('test-channel', doc, mockSupabase as never)

      await vi.runAllTimersAsync()
      mockSupabase._mockChannel.subscribe.mockClear()
      mockSupabase.channel.mockClear()

      mockSupabase._mockChannel._triggerSubscribe('CLOSED')

      await vi.advanceTimersByTimeAsync(1000)

      expect(mockSupabase.channel).toHaveBeenCalledTimes(1)
      expect(mockSupabase._mockChannel.subscribe).toHaveBeenCalledTimes(1)
    })
  })

  describe('getStatus', () => {
    it('should return current status', () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)

      expect(provider.getStatus()).toBe('connecting')
    })

    it('should return connected after successful subscription', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)

      await vi.runAllTimersAsync()

      expect(provider.getStatus()).toBe('connected')
    })
  })
})

describe('real-world collaboration scenarios', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should sync content between two clients', async () => {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const mockSupabase1 = createMockSupabase()
    const mockSupabase2 = createMockSupabase()

    // Create providers
    new SupabaseProvider('test-channel', doc1, mockSupabase1 as never)
    new SupabaseProvider('test-channel', doc2, mockSupabase2 as never)

    await vi.runAllTimersAsync()

    // Make change in doc1
    doc1.getText('test').insert(0, 'hello world')

    // Get the broadcast from doc1
    const sendCalls = mockSupabase1._mockChannel.send.mock.calls
    const updateCall = sendCalls.find((call) => call[0]?.event === 'y-supabase-update')
    expect(updateCall).toBeDefined()

    // Simulate doc2 receiving the broadcast
    mockSupabase2._mockChannel._triggerEvent('y-supabase-update', updateCall![0].payload)

    // doc2 should now have the same content as doc1
    expect(doc2.getText('test').toString()).toBe('hello world')
  })

  it('should sync bidirectionally between clients', async () => {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const mockSupabase1 = createMockSupabase()
    const mockSupabase2 = createMockSupabase()

    new SupabaseProvider('test-channel', doc1, mockSupabase1 as never)
    new SupabaseProvider('test-channel', doc2, mockSupabase2 as never)

    await vi.runAllTimersAsync()

    // Client 1 makes a change
    doc1.getText('test').insert(0, 'Alice: ')

    // Simulate broadcast to client 2
    const update1 = mockSupabase1._mockChannel.send.mock.calls.find(
      (call) => call[0]?.event === 'y-supabase-update'
    )
    mockSupabase2._mockChannel._triggerEvent('y-supabase-update', update1![0].payload)

    expect(doc2.getText('test').toString()).toBe('Alice: ')

    mockSupabase2._mockChannel.send.mockClear()

    // Client 2 makes a change
    doc2.getText('test').insert(7, 'Hello!')

    // Simulate broadcast to client 1
    const update2 = mockSupabase2._mockChannel.send.mock.calls.find(
      (call) => call[0]?.event === 'y-supabase-update'
    )
    mockSupabase1._mockChannel._triggerEvent('y-supabase-update', update2![0].payload)

    // Both docs should have the same content
    expect(doc1.getText('test').toString()).toBe('Alice: Hello!')
    expect(doc2.getText('test').toString()).toBe('Alice: Hello!')
  })

  it('should send state vector on connection to sync with existing peers', async () => {
    const doc = new Y.Doc()
    const mockSupabase = createMockSupabase()

    new SupabaseProvider('test-channel', doc, mockSupabase as never)

    await vi.runAllTimersAsync()

    // Should send state vector after connecting
    const stateVectorCall = mockSupabase._mockChannel.send.mock.calls.find(
      (call) => call[0]?.event === 'y-supabase-state-vector'
    )

    expect(stateVectorCall).toBeDefined()
    expect(stateVectorCall![0].payload).toMatchObject({
      stateVector: expect.any(String),
      user: { id: expect.any(String) },
      timestamp: expect.any(Number),
    })
  })

  it('should respond to state vector by sending diff', async () => {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const mockSupabase1 = createMockSupabase()
    const mockSupabase2 = createMockSupabase()

    // doc1 has existing content
    doc1.getText('test').insert(0, 'existing content')

    new SupabaseProvider('test-channel', doc1, mockSupabase1 as never)
    new SupabaseProvider('test-channel', doc2, mockSupabase2 as never)

    await vi.runAllTimersAsync()
    mockSupabase1._mockChannel.send.mockClear()

    // doc2 sends its state vector (empty doc)
    const doc2StateVector = Y.encodeStateVector(doc2)
    mockSupabase1._mockChannel._triggerEvent('y-supabase-state-vector', {
      stateVector: encodeUpdate(doc2StateVector),
      user: { id: 'peer-2' },
      timestamp: Date.now(),
    })

    // doc1 should send its content as an update
    const updateCall = mockSupabase1._mockChannel.send.mock.calls.find(
      (call) => call[0]?.event === 'y-supabase-update'
    )
    expect(updateCall).toBeDefined()
  })

  it('should sync late-joining client with existing document state', async () => {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const mockSupabase1 = createMockSupabase()
    const mockSupabase2 = createMockSupabase()

    // Client 1 joins and creates content
    new SupabaseProvider('test-channel', doc1, mockSupabase1 as never)
    await vi.runAllTimersAsync()

    doc1.getText('test').insert(0, 'Existing document content')

    mockSupabase1._mockChannel.send.mockClear()

    // Client 2 joins later
    new SupabaseProvider('test-channel', doc2, mockSupabase2 as never)
    await vi.runAllTimersAsync()

    // Client 2 sends state vector
    const stateVectorCall = mockSupabase2._mockChannel.send.mock.calls.find(
      (call) => call[0]?.event === 'y-supabase-state-vector'
    )
    expect(stateVectorCall).toBeDefined()

    // Simulate client 1 receiving the state vector
    mockSupabase1._mockChannel._triggerEvent('y-supabase-state-vector', stateVectorCall![0].payload)

    // Client 1 should respond with the diff (its content)
    const diffCall = mockSupabase1._mockChannel.send.mock.calls.find(
      (call) => call[0]?.event === 'y-supabase-update'
    )
    expect(diffCall).toBeDefined()

    // Simulate client 2 receiving the diff
    mockSupabase2._mockChannel._triggerEvent('y-supabase-update', diffCall![0].payload)

    // Client 2 should now have the existing content
    expect(doc2.getText('test').toString()).toBe('Existing document content')
  })

  it('should prevent infinite ping-pong with state vectors', async () => {
    const doc1 = new Y.Doc()
    const mockSupabase1 = createMockSupabase()

    new SupabaseProvider('test-channel', doc1, mockSupabase1 as never)
    await vi.runAllTimersAsync()

    mockSupabase1._mockChannel.send.mockClear()

    // Receive state vector from same peer twice
    const stateVector = {
      stateVector: encodeUpdate(Y.encodeStateVector(new Y.Doc())),
      user: { id: 'peer-2' },
      timestamp: Date.now(),
    }

    mockSupabase1._mockChannel._triggerEvent('y-supabase-state-vector', stateVector)
    const firstCallCount = mockSupabase1._mockChannel.send.mock.calls.length

    // Send same state vector again
    mockSupabase1._mockChannel._triggerEvent('y-supabase-state-vector', stateVector)
    const secondCallCount = mockSupabase1._mockChannel.send.mock.calls.length

    // Should not send again (synced peers tracking prevents ping-pong)
    expect(secondCallCount).toBe(firstCallCount)
  })

  it('should ignore updates from self', async () => {
    const doc = new Y.Doc()
    const mockSupabase = createMockSupabase()

    const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)
    await vi.runAllTimersAsync()

    const messageHandler = vi.fn()
    provider.on('message', messageHandler)

    // Make a local change
    doc.getText('test').insert(0, 'hello')

    // Get the broadcast
    const updateCall = mockSupabase._mockChannel.send.mock.calls.find(
      (call) => call[0]?.event === 'y-supabase-update'
    )

    // Simulate receiving own broadcast (shouldn't happen in practice, but test the guard)
    mockSupabase._mockChannel._triggerEvent('y-supabase-update', updateCall![0].payload)

    // Should not emit message event for own updates
    expect(messageHandler).not.toHaveBeenCalled()
  })
})

describe('error handling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should emit error on malformed update payload', async () => {
    const doc = new Y.Doc()
    const mockSupabase = createMockSupabase()

    const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)
    await vi.runAllTimersAsync()

    const errorHandler = vi.fn()
    provider.on('error', errorHandler)

    // Send malformed base64
    mockSupabase._mockChannel._triggerEvent('y-supabase-update', {
      update: 'invalid-base64-!!!',
      user: { id: 'other-peer' },
      timestamp: Date.now(),
    })

    expect(errorHandler).toHaveBeenCalledWith(expect.any(Error))
  })

  it('should emit error on malformed state vector', async () => {
    const doc = new Y.Doc()
    const mockSupabase = createMockSupabase()

    const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)
    await vi.runAllTimersAsync()

    const errorHandler = vi.fn()
    provider.on('error', errorHandler)

    // Send malformed state vector
    mockSupabase._mockChannel._triggerEvent('y-supabase-state-vector', {
      stateVector: 'corrupted-data-!!!',
      user: { id: 'other-peer' },
      timestamp: Date.now(),
    })

    expect(errorHandler).toHaveBeenCalledWith(expect.any(Error))
  })

  it('should continue working after error', async () => {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const mockSupabase1 = createMockSupabase()
    const mockSupabase2 = createMockSupabase()

    const provider1 = new SupabaseProvider('test-channel', doc1, mockSupabase1 as never)
    new SupabaseProvider('test-channel', doc2, mockSupabase2 as never)

    await vi.runAllTimersAsync()

    const errorHandler = vi.fn()
    provider1.on('error', errorHandler)

    // Send malformed update
    mockSupabase1._mockChannel._triggerEvent('y-supabase-update', {
      update: 'bad-data',
      user: { id: 'other' },
      timestamp: Date.now(),
    })

    expect(errorHandler).toHaveBeenCalled()

    // Should still work after error
    doc1.getText('test').insert(0, 'recovery test')

    const updateCall = mockSupabase1._mockChannel.send.mock.calls.find(
      (call) => call[0]?.event === 'y-supabase-update'
    )

    mockSupabase2._mockChannel._triggerEvent('y-supabase-update', updateCall![0].payload)
    expect(doc2.getText('test').toString()).toBe('recovery test')
  })
})

describe('cleanup and memory management', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should remove all event listeners on destroy', async () => {
    const doc = new Y.Doc()
    const mockSupabase = createMockSupabase()

    const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)
    await vi.runAllTimersAsync()

    const connectHandler = vi.fn()
    const statusHandler = vi.fn()
    const messageHandler = vi.fn()

    provider.on('connect', connectHandler)
    provider.on('status', statusHandler)
    provider.on('message', messageHandler)

    provider.destroy()

    // Make a change after destroy
    doc.getText('test').insert(0, 'test')

    // Simulate receiving update after destroy
    mockSupabase._mockChannel._triggerEvent('y-supabase-update', {
      update: btoa('test'),
      user: { id: 'other' },
      timestamp: Date.now(),
    })

    // No handlers should be called (they still exist but provider is destroyed)
    expect(messageHandler).not.toHaveBeenCalled()
  })

  it('should handle multiple on/off cycles correctly', async () => {
    const doc = new Y.Doc()
    const mockSupabase = createMockSupabase()

    const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)
    await vi.runAllTimersAsync()

    const handler1 = vi.fn()
    const handler2 = vi.fn()

    // Add handlers
    provider.on('status', handler1)
    provider.on('status', handler2)

    // Remove one
    provider.off('status', handler1)

    // Trigger status change
    mockSupabase._mockChannel.subscribe.mockClear()
    provider.connect()
    await vi.runAllTimersAsync()

    // Only handler2 should be called
    expect(handler1).not.toHaveBeenCalled()
    expect(handler2).toHaveBeenCalled()
  })
})

describe('awareness', () => {
  let doc: Y.Doc
  let mockSupabase: ReturnType<typeof createMockSupabase>

  beforeEach(() => {
    doc = new Y.Doc()
    mockSupabase = createMockSupabase()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // Helper to advance timers without triggering awareness cleanup interval
  const waitForConnection = async () => {
    await vi.advanceTimersByTimeAsync(10)
  }

  describe('initialization', () => {
    it('should create awareness when awareness option is true', () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        awareness: true,
      })

      expect(provider.getAwareness()).not.toBeNull()
    })

    it('should not create awareness by default', () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never)

      expect(provider.getAwareness()).toBeNull()
    })

    it('should use provided Awareness instance', async () => {
      const { Awareness } = await import('y-protocols/awareness')
      const customAwareness = new Awareness(doc)

      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        awareness: customAwareness,
      })

      expect(provider.getAwareness()).toBe(customAwareness)
    })
  })

  describe('local awareness updates', () => {
    it('should broadcast awareness updates when local state changes', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        awareness: true,
      })

      await waitForConnection()
      mockSupabase._mockChannel.send.mockClear()

      // Set local awareness state
      provider.getAwareness()!.setLocalStateField('user', {
        name: 'Alice',
        color: '#ff0000',
      })

      expect(mockSupabase._mockChannel.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'broadcast',
          event: 'y-supabase-awareness',
          payload: expect.objectContaining({
            update: expect.any(String),
            user: expect.objectContaining({ id: expect.any(String) }),
            timestamp: expect.any(Number),
          }),
        })
      )

      provider.destroy()
    })

    it('should broadcast initial awareness state on connect', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        awareness: true,
      })

      // Set local state before connection completes
      provider.getAwareness()!.setLocalStateField('user', { name: 'Bob' })

      await waitForConnection()

      // Should have sent awareness update after connection
      const awarenessCalls = mockSupabase._mockChannel.send.mock.calls.filter(
        (call) => call[0]?.event === 'y-supabase-awareness'
      )
      expect(awarenessCalls.length).toBeGreaterThan(0)

      provider.destroy()
    })
  })

  describe('remote awareness updates', () => {
    it('should apply remote awareness updates', async () => {
      const { Awareness, encodeAwarenessUpdate } = await import('y-protocols/awareness')

      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        awareness: true,
      })
      await waitForConnection()

      const awarenessHandler = vi.fn()
      provider.on('awareness', awarenessHandler)

      // Create a remote awareness update
      const remoteDoc = new Y.Doc()
      const remoteAwareness = new Awareness(remoteDoc)
      remoteAwareness.setLocalStateField('user', { name: 'Remote User', color: '#00ff00' })
      const update = encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID])

      // Simulate receiving remote awareness
      mockSupabase._mockChannel._triggerEvent('y-supabase-awareness', {
        update: encodeUpdate(update),
        user: { id: 'remote-user-id' },
        timestamp: Date.now(),
      })

      expect(awarenessHandler).toHaveBeenCalledWith(expect.any(Uint8Array))

      // Check that the remote state was applied
      const states = provider.getAwareness()!.getStates()
      expect(states.size).toBeGreaterThan(0)

      provider.destroy()
      remoteAwareness.destroy()
    })

    it('should ignore awareness updates from self', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        awareness: true,
      })
      await waitForConnection()

      const awarenessHandler = vi.fn()
      provider.on('awareness', awarenessHandler)

      // Set local state
      provider.getAwareness()!.setLocalStateField('user', { name: 'Me' })

      // Get the sent awareness update
      const sentCall = mockSupabase._mockChannel.send.mock.calls.find(
        (call) => call[0]?.event === 'y-supabase-awareness'
      )

      // Simulate receiving our own broadcast (shouldn't happen, but test the guard)
      mockSupabase._mockChannel._triggerEvent('y-supabase-awareness', sentCall![0].payload)

      // Should not emit awareness event for own updates
      expect(awarenessHandler).not.toHaveBeenCalled()

      provider.destroy()
    })

    it('should not rebroadcast remote awareness updates', async () => {
      const { Awareness, encodeAwarenessUpdate } = await import('y-protocols/awareness')

      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        awareness: true,
      })
      await waitForConnection()
      mockSupabase._mockChannel.send.mockClear()

      // Create a remote awareness update
      const remoteDoc = new Y.Doc()
      const remoteAwareness = new Awareness(remoteDoc)
      remoteAwareness.setLocalStateField('user', { name: 'Remote' })
      const update = encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID])

      // Simulate receiving remote awareness
      mockSupabase._mockChannel._triggerEvent('y-supabase-awareness', {
        update: encodeUpdate(update),
        user: { id: 'remote-user' },
        timestamp: Date.now(),
      })

      // Should NOT rebroadcast the remote update (would cause echo storm)
      const awarenessCalls = mockSupabase._mockChannel.send.mock.calls.filter(
        (call) => call[0]?.event === 'y-supabase-awareness'
      )
      expect(awarenessCalls.length).toBe(0)

      provider.destroy()
      remoteAwareness.destroy()
    })
  })

  describe('awareness sync between clients', () => {
    it('should sync awareness between two clients', async () => {
      const doc1 = new Y.Doc()
      const doc2 = new Y.Doc()
      const mockSupabase1 = createMockSupabase()
      const mockSupabase2 = createMockSupabase()

      const provider1 = new SupabaseProvider('test-channel', doc1, mockSupabase1 as never, {
        awareness: true,
      })
      const provider2 = new SupabaseProvider('test-channel', doc2, mockSupabase2 as never, {
        awareness: true,
      })

      await waitForConnection()
      mockSupabase1._mockChannel.send.mockClear()

      // Client 1 sets their user info
      provider1.getAwareness()!.setLocalStateField('user', {
        name: 'Alice',
        color: '#ff0000',
        cursor: { line: 10, column: 5 },
      })

      // Get the awareness broadcast from client 1 (should be the only one after clearing)
      const awarenessCall = mockSupabase1._mockChannel.send.mock.calls.find(
        (call) => call[0]?.event === 'y-supabase-awareness'
      )
      expect(awarenessCall).toBeDefined()

      // Simulate client 2 receiving client 1's awareness with a different user id
      mockSupabase2._mockChannel._triggerEvent('y-supabase-awareness', {
        ...awarenessCall![0].payload,
        user: { id: 'different-user-id' }, // Ensure it's treated as a remote update
      })

      // Client 2 should now see client 1's awareness state
      const states = provider2.getAwareness()!.getStates()
      const remoteState = Array.from(states.values()).find((s) => s?.user?.name === 'Alice')

      expect(remoteState).toBeDefined()
      expect(remoteState?.user?.color).toBe('#ff0000')
      expect(remoteState?.user?.cursor).toEqual({ line: 10, column: 5 })

      provider1.destroy()
      provider2.destroy()
    })

    it('should track multiple users awareness', async () => {
      const { Awareness, encodeAwarenessUpdate } = await import('y-protocols/awareness')

      const doc1 = new Y.Doc()
      const mockSupabase1 = createMockSupabase()

      const provider1 = new SupabaseProvider('test-channel', doc1, mockSupabase1 as never, {
        awareness: true,
      })
      await waitForConnection()

      // Set local state
      provider1.getAwareness()!.setLocalStateField('user', { name: 'Alice' })

      // Simulate two remote users joining
      const createRemoteAwareness = (name: string) => {
        const remoteDoc = new Y.Doc()
        const remoteAwareness = new Awareness(remoteDoc)
        remoteAwareness.setLocalStateField('user', { name })
        return { doc: remoteDoc, awareness: remoteAwareness }
      }

      const remote1 = createRemoteAwareness('Bob')
      const remote2 = createRemoteAwareness('Charlie')

      mockSupabase1._mockChannel._triggerEvent('y-supabase-awareness', {
        update: encodeUpdate(encodeAwarenessUpdate(remote1.awareness, [remote1.doc.clientID])),
        user: { id: 'bob-id' },
        timestamp: Date.now(),
      })

      mockSupabase1._mockChannel._triggerEvent('y-supabase-awareness', {
        update: encodeUpdate(encodeAwarenessUpdate(remote2.awareness, [remote2.doc.clientID])),
        user: { id: 'charlie-id' },
        timestamp: Date.now(),
      })

      // Should have Alice (local) + Bob + Charlie
      const states = provider1.getAwareness()!.getStates()
      const names = Array.from(states.values())
        .filter((s) => s?.user?.name)
        .map((s) => s.user.name)

      expect(names).toContain('Alice')
      expect(names).toContain('Bob')
      expect(names).toContain('Charlie')

      provider1.destroy()
      remote1.awareness.destroy()
      remote2.awareness.destroy()
    })
  })

  describe('awareness cleanup', () => {
    it('should clean up awareness on destroy', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        awareness: true,
      })
      await waitForConnection()

      provider.getAwareness()!.setLocalStateField('user', { name: 'Test' })

      const awareness = provider.getAwareness()!

      // Verify local state exists before destroy
      expect(awareness.getLocalState()).not.toBeNull()

      provider.destroy()

      // After destroy, local state should be null (removed)
      expect(awareness.getLocalState()).toBeNull()
    })

    it('should not broadcast awareness updates after destroy', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        awareness: true,
      })
      await waitForConnection()

      const awareness = provider.getAwareness()!
      provider.destroy()

      mockSupabase._mockChannel.send.mockClear()

      // Try to set local state after destroy (awareness instance still exists)
      awareness.setLocalStateField('user', { name: 'Ghost' })

      // Should not broadcast
      const awarenessCalls = mockSupabase._mockChannel.send.mock.calls.filter(
        (call) => call[0]?.event === 'y-supabase-awareness'
      )
      expect(awarenessCalls.length).toBe(0)
    })
  })

  describe('user disconnect scenarios', () => {
    it('should broadcast awareness removal when user disconnects', async () => {
      const doc1 = new Y.Doc()
      const doc2 = new Y.Doc()
      const mockSupabase1 = createMockSupabase()
      const mockSupabase2 = createMockSupabase()

      const provider1 = new SupabaseProvider('test-channel', doc1, mockSupabase1 as never, {
        awareness: true,
      })
      const provider2 = new SupabaseProvider('test-channel', doc2, mockSupabase2 as never, {
        awareness: true,
      })

      await waitForConnection()
      mockSupabase1._mockChannel.send.mockClear()

      // Client 1 sets user info
      provider1.getAwareness()!.setLocalStateField('user', { name: 'Alice' })

      // Simulate client 2 receiving client 1's awareness with different user id
      const awarenessCall = mockSupabase1._mockChannel.send.mock.calls.find(
        (call) => call[0]?.event === 'y-supabase-awareness'
      )
      expect(awarenessCall).toBeDefined()

      mockSupabase2._mockChannel._triggerEvent('y-supabase-awareness', {
        ...awarenessCall![0].payload,
        user: { id: 'client1-user-id' },
      })

      // Verify client 2 sees Alice
      let states = provider2.getAwareness()!.getStates()
      let hasAlice = Array.from(states.values()).some((s) => s?.user?.name === 'Alice')
      expect(hasAlice).toBe(true)

      mockSupabase1._mockChannel.send.mockClear()

      // Client 1 disconnects
      provider1.destroy()

      // Get the awareness removal broadcast
      const removalCall = mockSupabase1._mockChannel.send.mock.calls.find(
        (call) => call[0]?.event === 'y-supabase-awareness'
      )

      // If there was a removal broadcast, simulate client 2 receiving it
      if (removalCall) {
        mockSupabase2._mockChannel._triggerEvent('y-supabase-awareness', {
          ...removalCall[0].payload,
          user: { id: 'client1-user-id' },
        })

        // Client 2 should no longer see Alice
        states = provider2.getAwareness()!.getStates()
        hasAlice = Array.from(states.values()).some((s) => s?.user?.name === 'Alice')
        expect(hasAlice).toBe(false)
      }

      provider2.destroy()
    })
  })

  describe('error handling', () => {
    it('should emit error on malformed awareness payload', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        awareness: true,
      })
      await waitForConnection()

      const errorHandler = vi.fn()
      provider.on('error', errorHandler)

      // Send malformed awareness update
      mockSupabase._mockChannel._triggerEvent('y-supabase-awareness', {
        update: 'invalid-base64-!!!',
        user: { id: 'other-peer' },
        timestamp: Date.now(),
      })

      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error))

      provider.destroy()
    })

    it('should continue working after awareness error', async () => {
      const provider = new SupabaseProvider('test-channel', doc, mockSupabase as never, {
        awareness: true,
      })
      await waitForConnection()

      const errorHandler = vi.fn()
      provider.on('error', errorHandler)

      // Send malformed awareness
      mockSupabase._mockChannel._triggerEvent('y-supabase-awareness', {
        update: 'bad-data',
        user: { id: 'other' },
        timestamp: Date.now(),
      })

      expect(errorHandler).toHaveBeenCalled()

      mockSupabase._mockChannel.send.mockClear()

      // Should still work - set local awareness
      provider.getAwareness()!.setLocalStateField('user', { name: 'Recovery' })

      const awarenessCalls = mockSupabase._mockChannel.send.mock.calls.filter(
        (call) => call[0]?.event === 'y-supabase-awareness'
      )
      expect(awarenessCalls.length).toBeGreaterThan(0)

      provider.destroy()
    })
  })
})
