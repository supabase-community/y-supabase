import * as Y from 'yjs'
import { MonacoBinding } from 'y-monaco'
import * as monaco from 'monaco-editor'
import { createBrowserClient } from "@supabase/ssr";
import { SupabaseProvider } from '../../src'

// Replace these with your actual Supabase project credentials
const supabaseUrl = 'supbase_url'
const supabaseKey = 'supabase_key'

// Initialize Supabase client
const supabase = createBrowserClient(supabaseUrl, supabaseKey);

// Create Yjs document and provider
const ydoc = new Y.Doc()
const provider = new SupabaseProvider('monaco-demo', ydoc, supabase)

const ytext = ydoc.getText('monaco')

// Create Monaco editor
const editor = monaco.editor.create(document.getElementById('editor')!, {
  value: '',
  language: 'javascript',
  theme: 'vs-dark',
})

// Bind Yjs to Monaco
new MonacoBinding(
  ytext,
  editor.getModel()!,
  new Set([editor]),
  undefined
)

// Update status indicator
const statusEl = document.getElementById('status')!
provider.on('status', (status) => {
  console.log('Status changed to', status)
  statusEl.textContent = status
  statusEl.className = status
})
provider.on('error', (error) => console.error('Provider error:', error))