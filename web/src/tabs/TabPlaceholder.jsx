// Generic placeholder shown for any tab whose real implementation hasn't landed yet.
// Each tab gets replaced with its real component in its own migration phase — see
// MIGRATION_PLAN.md. Phase 0 only ships the nav shell.
export default function TabPlaceholder({ name, phase }) {
  return (
    <div className="tab-placeholder">
      <h2>{name}</h2>
      <p>
        Not built yet — this tab ships in <strong>{phase}</strong> of the React
        migration. Until then, the working version of this feature is live at the
        original app.
      </p>
    </div>
  );
}
