import snapshot from "@/app/data/ic-timetable.json";
import { currentSnapshot } from "@/app/lib/snapshot-source";
import type { TimetableSnapshot } from "@/app/lib/timetable";
import { jsonResponse } from "@/app/lib/http";

export async function GET() {
  const data = await currentSnapshot(snapshot as unknown as TimetableSnapshot);
  const daysRemaining = Math.floor((Date.parse(`${data.validThrough}T23:59:59Z`) - Date.now()) / 86400000);
  const snapshotReady = daysRemaining >= 7;
  console.info(JSON.stringify({ event: "snapshot_health", daysRemaining, snapshotReady }));
  return jsonResponse({ status: snapshotReady ? "ok" : "degraded", snapshot: {
    generatedAt: data.generatedAt, validThrough: data.validThrough, daysRemaining,
  } }, { status: snapshotReady ? 200 : 503 });
}
