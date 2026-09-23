import { Link, useLocation } from "react-router";

/**
 * Tab navigation across the project screens: Deck info (name/description/
 * location/categories/tags) first — the deck's settings govern the card work
 * — then Cards (the species list), Review, Export.
 */

export function ProjectTabs({ projectId, active }: { projectId: string; active: "cards" | "info" | "review" | "export" }) {
  const location = useLocation();
  void location;
  const tabs: Array<{ id: typeof active; label: string; to: string }> = [
    { id: "info", label: "ℹ️ Deck info", to: `/project/${projectId}/info` },
    { id: "cards", label: "🗂 Cards", to: `/project/${projectId}` },
    { id: "review", label: "🔍 Review", to: `/project/${projectId}/review` },
    { id: "export", label: "📦 Export", to: `/project/${projectId}/export` },
  ];
  return (
    <nav className="flex flex-wrap gap-2" data-testid="project-tabs">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          to={tab.to}
          className={`btn text-sm ${active === tab.id ? "btn-primary" : "btn-secondary"}`}
          data-testid={`tab-${tab.id}`}
          aria-current={active === tab.id ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
