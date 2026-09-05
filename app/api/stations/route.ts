import snapshot from "@/app/data/ic-timetable.json";
import stations from "@/public/stations.json";
import { currentSnapshot } from "@/app/lib/snapshot-source";
import type { TimetableSnapshot } from "@/app/lib/timetable";
import { jsonResponse } from "@/app/lib/http";

export async function GET() {
  const data = await currentSnapshot(snapshot as unknown as TimetableSnapshot);
  return jsonResponse(data.stations ?? stations);
}
