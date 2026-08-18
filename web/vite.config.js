import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Phase 6 (MIGRATION_PLAN.md) cutover: now served at the domain root instead of the
// /react-preview/ staging subpath used for Phases 0-5, so `base` goes back to the
// default ('/'). This MUST ship together with the matching nginx change (root pointed
// at the React build's directory instead of /var/www/talkbridge, and the now-redundant
// /react-preview/ location block removed) -- deploying only one half would 404 every
// asset (old base baked into old JS/CSS references vs. new nginx root, or vice versa).
export default defineConfig({
  plugins: [react()],
})
