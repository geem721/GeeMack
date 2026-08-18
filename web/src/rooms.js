// Single source of truth for the fixed room list — shared by Group Chat (Phase 4) and
// Video Call (Phase 5). Same rationale as languages.js: this used to only exist inside
// Group Chat's markup in public/index.html; pulling it out here means Video Call (now a
// separate top-level tab, not nested inside Group Chat — see MIGRATION_PLAN.md's
// 2026-08-16 decision) can reference the identical room identifiers without a second
// hand-typed copy drifting out of sync.
export const ROOMS = ["general", "support", "travel", "business", "casual"];
