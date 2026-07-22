import { isAlwaysEnabledSkillName } from "./builtin";
import type { SkillSummary } from "./index";

export type InstalledSkillCardSource = "built-in" | "clawhub" | "local";

export type RelativeInstalledAt =
  | { kind: "today" }
  | { kind: "days-ago"; days: number }
  | { kind: "date"; timestamp: number };

const RECENT_INSTALL_DAYS = 6;

export function getInstalledSkillCardSource(
  skill: Pick<SkillSummary, "name" | "source" | "builtIn">,
): InstalledSkillCardSource {
  if (skill.builtIn === true || isAlwaysEnabledSkillName(skill.name)) return "built-in";
  return skill.source?.registry.trim().toLowerCase() === "clawhub" ? "clawhub" : "local";
}

function calendarDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function getRelativeInstalledAt(
  installedAt: number | null | undefined,
  now = Date.now(),
): RelativeInstalledAt | null {
  if (typeof installedAt !== "number" || !Number.isFinite(installedAt) || !Number.isFinite(now)) {
    return null;
  }

  const installedDay = calendarDay(installedAt);
  const currentDay = calendarDay(now);
  if (!Number.isFinite(installedDay) || !Number.isFinite(currentDay)) return null;

  const days = Math.floor((currentDay - installedDay) / 86_400_000);
  if (days <= 0) return { kind: "today" };
  if (days <= RECENT_INSTALL_DAYS) return { kind: "days-ago", days };
  return { kind: "date", timestamp: installedAt };
}
