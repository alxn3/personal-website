import type { CollectionEntry } from "astro:content";

type Project = CollectionEntry<"projects">;

export interface RailGroup {
  /** null = root-level projects (rendered first, headerless) */
  label: string | null;
  items: Project[];
}

// kebab-case folder segment → Title Case header ("demos" → "Demos")
const toGroupLabel = (segment: string) =>
  segment
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/**
 * Project-rail grouping: an id with a subfolder (e.g. "demos/lens") files
 * under a header derived from its first path segment; root-level ids list
 * first with no header.
 */
export function buildRailGroups(projects: Project[]): RailGroup[] {
  const groupNames = [
    ...new Set(
      projects
        .filter((item) => item.id.includes("/"))
        .map((item) => item.id.split("/")[0]),
    ),
  ];
  return [
    {
      label: null,
      items: projects.filter((item) => !item.id.includes("/")),
    },
    ...groupNames.map((name) => ({
      label: toGroupLabel(name),
      items: projects.filter(
        (item) => item.id.includes("/") && item.id.split("/")[0] === name,
      ),
    })),
  ].filter((group) => group.items.length > 0);
}
