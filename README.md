# y-supabase

A [Yjs](https://yjs.dev/) provider that enables real-time collaboration through [Supabase Realtime](https://supabase.com/docs/guides/realtime).

## Features

- **Real-time sync** - Sync document changes across clients using Supabase Realtime broadcast
- **Awareness** - Track user presence, cursors, and selections with `y-protocols/awareness`
- **Lightweight** - Minimal dependencies, works with any Yjs-compatible editor
- **TypeScript** - Full TypeScript support with type definitions

## Installation

```bash
npm install @supabase-community/y-supabase yjs @supabase/supabase-js
```

## Quick Start

```typescript
import * as Y from 'yjs'
import { createClient } from '@supabase/supabase-js'
import { SupabaseProvider } from '@supabase-community/y-supabase'

// Create a Yjs document
const doc = new Y.Doc()

// Create Supabase client
const supabase = createClient(
  'https://your-project.supabase.co',
  'your-anon-key'
)

// Create the provider
const provider = new SupabaseProvider('my-room', doc, supabase)

// Listen to connection events
provider.on('connect', () => {
  console.log('Connected to Supabase Realtime')
})

provider.on('error', (error) => {
  console.error('Provider error:', error)
})

// Use with any Yjs-compatible editor (Tiptap, Lexical, Monaco, etc.)
const yText = doc.getText('content')
```

## Configuration

### Options

```typescript
type SupabaseProviderOptions = {
  // Throttle broadcast updates (ms)
  broadcastThrottleMs?: number

  // Enable automatic reconnection on disconnect (default: true)
  autoReconnect?: boolean

  // Maximum reconnection attempts (default: Infinity)
  maxReconnectAttempts?: number

  // Initial reconnection delay in ms (default: 1000)
  reconnectDelay?: number

  // Maximum reconnection delay in ms (default: 30000)
  // Uses exponential backoff: 1s, 2s, 4s, 8s
  maxReconnectDelay?: number

  // Enable awareness for user presence (cursors, selections, etc.)
  // Pass `true` to create a new Awareness instance, or pass an existing one
  awareness?: boolean | Awareness
}
```

**Example with custom reconnection:**

```typescript
const provider = new SupabaseProvider('my-room', doc, supabase, {
  autoReconnect: true,
  maxReconnectAttempts: 5,
  reconnectDelay: 2000,
  maxReconnectDelay: 60000
})
```

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connect` | `provider` | Connected to Supabase Realtime |
| `disconnect` | `provider` | Disconnected from channel |
| `status` | `'connecting' \| 'connected' \| 'disconnected'` | Connection status changed |
| `message` | `Uint8Array` | Received update from peer |
| `awareness` | `Uint8Array` | Received awareness update from peer |
| `error` | `Error` | An error occurred (e.g., failed to decode update) |

## API

### `new SupabaseProvider(channelName, doc, supabase, options?)`

Creates a new provider instance.

- `channelName` - Unique identifier for the collaboration room
- `doc` - Yjs document instance
- `supabase` - Supabase client instance
- `options` - Optional configuration options (see above)

### Methods

- `connect()` - Connect to the channel (called automatically)
- `destroy()` - Disconnect and clean up resources
- `getStatus()` - Get current connection status
- `getAwareness()` - Get the Awareness instance (or `null` if not enabled)
- `on(event, listener)` - Subscribe to events
- `off(event, listener)` - Unsubscribe from events

## Awareness

Awareness enables real-time presence features like user cursors, selections, and online status. It uses the standard `y-protocols/awareness` protocol, making it compatible with all Yjs editor bindings.

### Enabling Awareness

```typescript
const provider = new SupabaseProvider('my-room', doc, supabase, {
  awareness: true
})

// Set local user presence
const awareness = provider.getAwareness()!
awareness.setLocalStateField('user', {
  name: 'Alice',
  color: '#ff0000',
  cursor: { line: 10, column: 5 }
})

// Listen for remote awareness changes
provider.on('awareness', (update) => {
  console.log('Remote presence updated')
})

// Get all connected users
const states = awareness.getStates()
states.forEach((state, clientId) => {
  console.log(`User ${state?.user?.name} is online`)
})
```

### Using an Existing Awareness Instance

```typescript
import { Awareness } from 'y-protocols/awareness'

const awareness = new Awareness(doc)
const provider = new SupabaseProvider('my-room', doc, supabase, {
  awareness: awareness
})
```

### Cleanup

Awareness states are automatically cleaned up when:
- `provider.destroy()` is called
- The user closes the browser tab (via `beforeunload` event)

## Usage with Editors

### Monaco

```typescript
import * as Y from 'yjs'
import { MonacoBinding } from 'y-monaco'
import * as monaco from 'monaco-editor'
import { createClient } from '@supabase/supabase-js'
import { SupabaseProvider } from '@supabase-community/y-supabase'

const supabase = createClient('https://...', 'your-key')
const doc = new Y.Doc()
const provider = new SupabaseProvider('my-room', doc, supabase, {
  awareness: true
})

// Set user info for cursor display
const awareness = provider.getAwareness()!
awareness.setLocalStateField('user', {
  name: 'User ' + Math.floor(Math.random() * 100),
  color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')
})

const ytext = doc.getText('monaco')
const editor = monaco.editor.create(document.getElementById('editor')!, {
  value: '',
  language: 'javascript',
})

// Pass awareness for cursor/selection sync
new MonacoBinding(ytext, editor.getModel()!, new Set([editor]), awareness)
```

## License

MIT
