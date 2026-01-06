# y-supabase

A [Yjs](https://yjs.dev/) provider that enables real-time collaboration through [Supabase Realtime](https://supabase.com/docs/guides/realtime).

## Features

- **Real-time sync** - Sync document changes across clients using Supabase Realtime broadcast
- **Lightweight** - Minimal dependencies, works with any Yjs-compatible editor
- **TypeScript** - Full TypeScript support with type definitions

## Installation

```bash
npm install @tiagoantunespt/y-supabase yjs @supabase/supabase-js
```

## Quick Start

```typescript
import * as Y from 'yjs'
import { createClient } from '@supabase/supabase-js'
import { SupabaseProvider } from '@tiagoantunespt/y-supabase'

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
- `on(event, listener)` - Subscribe to events
- `off(event, listener)` - Unsubscribe from events

## Usage with Editors

### Monaco

```typescript
import * as Y from 'yjs'
import { MonacoBinding } from 'y-monaco'
import * as monaco from 'monaco-editor'
import { createClient } from '@supabase/supabase-js'
import { SupabaseProvider } from '@tiagoantunespt/y-supabase'

const supabase = createClient('https://...', 'your-key')
const doc = new Y.Doc()
const provider = new SupabaseProvider('my-room', doc, supabase)

const ytext = doc.getText('monaco')
const editor = monaco.editor.create(document.getElementById('editor')!, {
  value: '',
  language: 'javascript',
})

new MonacoBinding(ytext, editor.getModel()!, new Set([editor]))
```

## License

MIT
