import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served from a subpath on Apollo1 (talk-bridge.org/react-preview/) rather than the
// domain root, via nginx -- see MIGRATION_PLAN.md / PROJECT_LOG.md (2026-08-16) for why:
// this reuses the existing HTTPS cert, and HTTPS is a hard requirement once Phase 1+
// need getUserMedia (mic/camera), which browsers refuse to grant over plain HTTP.
// `base` must match the nginx location path exactly, including trailing slash, or the
// built JS/CSS asset URLs will 404.
export default defineConfig({
  base: '/react-preview/',
  plugins: [react()],
})
