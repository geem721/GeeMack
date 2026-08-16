import TabPlaceholder from "./TabPlaceholder.jsx";

// Its own top-level tab, not nested inside Group Chat — per the 2026-08-16 decision.
// The old public/index.html buried the video call control inside the Group Chat panel;
// this promotes it to a sibling tab. See MIGRATION_PLAN.md Phase 5.
export default function VideoCall() {
  return <TabPlaceholder name="Video Call" phase="Phase 5" />;
}
