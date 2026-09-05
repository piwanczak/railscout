const target = process.env.SITE_HEALTH_URL ?? "https://railscout-pl.pbi135543.chatgpt.site/api/health";
try {
  const response = await fetch(target, { signal: AbortSignal.timeout(15000), redirect: "error" });
  const health = await response.json();
  if (!response.ok || health.status !== "ok" || !(health.snapshot?.daysRemaining >= 7)) {
    throw new Error("Deployed timetable needs attention");
  }
  console.log(`Deployed timetable is valid through ${health.snapshot.validThrough}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Deployment health check failed");
  process.exitCode = 1;
}
