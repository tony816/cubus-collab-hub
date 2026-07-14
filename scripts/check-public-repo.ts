import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const forbidden = [
  /VIEW LIFW/i,
  /1-6fr5izGZfWUsnXpqong004JNwrroeBGXufFjqcEcQ4/,
  /1H3ssn3rI9ovgZ_YgeU-E_udXOxBRi61d/,
  /1qyyA7DPC31A-eIK6jhTaXYfR-mzdjpSx0-QUZatuoIM/,
  /sb_secret_[A-Za-z0-9_-]+/,
  /gh[opusr]_[A-Za-z0-9]{20,}/,
];
const violations: string[] = [];
for (const file of tracked) {
  if (file === "scripts/check-public-repo.ts") continue;
  if (/\.(png|jpg|jpeg|gif|ico|woff2?)$/i.test(file)) continue;
  const content = readFileSync(file, "utf8");
  if (forbidden.some((pattern) => pattern.test(content))) violations.push(file);
}
if (violations.length > 0) {
  throw new Error(`Private data or secret pattern found in: ${violations.join(", ")}`);
}
console.log(`Public repository scan passed (${tracked.length} tracked files)`);
