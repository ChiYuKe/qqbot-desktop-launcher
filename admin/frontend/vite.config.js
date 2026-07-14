import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The desktop shell loads the built page through file://, so assets must be
// relative to index.html instead of resolving from the filesystem root.
export default defineConfig({ base: './', plugins: [react()] })
