import TabPlaceholder from "./TabPlaceholder.jsx";

// Not yet assigned its own migration phase in MIGRATION_PLAN.md — today's app couples
// translation history to the Translate tab (localStorage-backed), so this will most
// likely land alongside Phase 1 rather than as a separate phase. Flagging here rather
// than guessing a phase number the plan doesn't actually specify.
export default function History() {
  return <TabPlaceholder name="History" phase="a future phase (not yet scoped)" />;
}
