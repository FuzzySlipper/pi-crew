/**
 * Provenance migration — one-time scan of existing skill directories
 * to classify and write .provenance markers.
 *
 * Run: npx tsx scripts/provenance-migration.ts <skillsRoot>
 *
 * Classification:
 * - In .global/ subdirectory → "bundled"
 * - In .profile/ subdirectory → "profile"
 * - Any skill with .pinned marker → also gets "pinned" override in state
 * - Everything else → "agent"
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

const [skillsRoot] = process.argv.slice(2);

if (!skillsRoot || !existsSync(skillsRoot)) {
  console.error("Usage: npx tsx scripts/provenance-migration.ts <skillsRoot>");
  process.exit(1);
}

const results = { bundled: 0, profile: 0, agent: 0, pinned: 0, errors: 0 };

const entries = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("."))
  .map((d) => d.name);

for (const name of entries) {
  const skillDir = join(skillsRoot, name);
  const provenanceFile = join(skillDir, ".provenance");
  const pinnedFile = join(skillDir, ".pinned");
  const isPinned = existsSync(pinnedFile);

  // Determine provenance
  let provenance: string;
  if (isPinned) {
    provenance = "pinned";
    results.pinned++;
  } else if (name.startsWith(".")) {
    continue;
  } else {
    // Check if in global skills dir by path heuristic
    if (skillsRoot.includes("global") || skillsRoot.includes("bundled")) {
      provenance = "bundled";
      results.bundled++;
    } else if (name.startsWith("profile-")) {
      provenance = "profile";
      results.profile++;
    } else {
      provenance = "agent";
      results.agent++;
    }
  }

  try {
    writeFileSync(provenanceFile, `${provenance}\n`, "utf-8");
  } catch (err) {
    console.error(`Failed to write provenance for ${name}:`, err);
    results.errors++;
  }
}

console.log(`Provenance migration complete:
  Bundled: ${results.bundled}
  Profile: ${results.profile}
  Agent:   ${results.agent}
  Pinned:  ${results.pinned}
  Errors:  ${results.errors}
  Total:   ${entries.length}`);
