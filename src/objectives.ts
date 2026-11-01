// The shared objectives list (api.fc-tracker.com/v1/objectives): one user's sync is enough for
// everyone. Right after a Web App sync this device sends the objective events it saw – titles,
// texts, targets, end times, plus EA's public name lists and formations – without the user's
// progress and without who sent it. Every device (the app, FC-Tracker Web, users who never press
// sync) takes the open events from the list: at start, every 10 minutes and after a sync. The
// user's own events, with their progress, always win; the shared ones only fill in.
import { api } from "./api";

const URL_ = "https://api.fc-tracker.com/v1/objectives";
const PULL_EVERY = 10 * 60 * 1000;

type Share = { groups?: unknown[]; names?: unknown; formations?: unknown } | null;

/** Sends what this device's sync saw (definitions only). */
export async function shareObjectives(): Promise<void> {
  const s = (await api.objectivesShare().catch(() => null)) as Share;
  if (!s?.groups?.length) return;
  await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }).catch(() => {});
}

/** Takes the open events from the shared list (own events and progress stay). */
export async function pullObjectives(): Promise<void> {
  const r = await fetch(URL_).catch(() => null);
  if (!r?.ok) return;
  const cat = await r.json().catch(() => null);
  if (cat?.groups?.length) await api.applySharedObjectives(cat).catch(() => false);
}

/** After a sync: send first (so the list has it), then take what others saw. */
export async function afterSync(): Promise<void> {
  await shareObjectives();
  await pullObjectives();
}

const FACTS = "https://api.fc-tracker.com/v1/availability";
const VOTER = "fct.voter";

/** "Is it still available?" – what users established together; the planner uses it. */
export async function pullFacts(): Promise<void> {
  const r = await fetch(FACTS).catch(() => null);
  if (!r?.ok) return;
  const j = await r.json().catch(() => null);
  if (j?.facts && typeof j.facts === "object") await api.setSquadFacts(j.facts).catch(() => {});
}

/** The user's answer counts as one vote (a random id of this device, only its hash is kept). */
export async function voteAvailability(name: string, available: boolean): Promise<void> {
  let voter = "";
  try {
    voter = localStorage.getItem(VOTER) ?? "";
    if (voter.length < 16) {
      voter = crypto.randomUUID();
      localStorage.setItem(VOTER, voter);
    }
  } catch {
    voter = crypto.randomUUID();
  }
  await fetch(FACTS, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, available, voter }) }).catch(() => {});
}

let started = false;
export function startObjectives(): void {
  if (started) return;
  started = true;
  setTimeout(() => void pullObjectives(), 5_000);
  setInterval(() => void pullObjectives(), PULL_EVERY);
  setTimeout(() => void pullFacts(), 6_000);
  setInterval(() => void pullFacts(), PULL_EVERY);
}
