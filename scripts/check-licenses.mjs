import { access, readFile } from "node:fs/promises";

const packageManifest = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const rootLockEntry = lock.packages?.[""];

const errors = [];
if (packageManifest.license !== "MIT" || rootLockEntry?.license !== "MIT") {
  errors.push("package.json and the lockfile root must declare MIT");
}

for (const requiredFile of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  try {
    await access(requiredFile);
  } catch {
    errors.push(`${requiredFile} is missing`);
  }
}

const packages = Object.entries(lock.packages ?? {}).flatMap(([path, value]) =>
  path && value && typeof value === "object"
    ? [
        {
          name: value.name ?? path.split("node_modules/").at(-1),
          version: value.version ?? "unknown",
          license: value.license ?? "",
        },
      ]
    : [],
);
const missing = packages.filter(
  ({ license }) =>
    !license || /UNKNOWN|UNLICENSED|SEE LICENSE|LicenseRef/i.test(license),
);
const manualReview = packages.filter(({ license }) =>
  /AGPL|SSPL|BUSL|Commons[- ]Clause/i.test(license),
);

for (const dependency of missing) {
  errors.push(
    `${dependency.name}@${dependency.version} has no machine-readable license`,
  );
}
for (const dependency of manualReview) {
  errors.push(
    `${dependency.name}@${dependency.version} requires manual license review (${dependency.license})`,
  );
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  const licenseCount = new Set(packages.map(({ license }) => license)).size;
  console.log(
    `License metadata verified for ${packages.length} dependency entries across ${licenseCount} SPDX expressions.`,
  );
}
