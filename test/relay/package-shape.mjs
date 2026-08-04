import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function runPackageShape(h) {
  const skillsDir = join(h.testDir, "..", "skills");
  const onDisk = readdirSync(skillsDir).filter((d) => d.endsWith("-delegate")).sort();
  const registered = new Set(
    JSON.parse(readFileSync(join(h.testDir, "..", "skills.sh.json"), "utf8"))
      .groupings.flatMap((g) => g.skills),
  );
  const REFERENCES = ["writing-the-brief", "dispatch-and-poll", "review-and-land", "multi-task-queues"];

  h.check("skills/ is not empty", onDisk.length > 0);
  for (const dir of onDisk) {
    const name = dir.replace(/-delegate$/, "");
    h.check(`${name}: in the smoke matrix`, h.SKILLS.includes(name));
    h.check(`${name}: SKILL.md`, existsSync(join(skillsDir, dir, "SKILL.md")));
    h.check(`${name}: scripts/relay.mjs`, existsSync(join(skillsDir, dir, "scripts", "relay.mjs")));
    h.check(
      `${name}: exactly the four references`,
      REFERENCES.every((r) => existsSync(join(skillsDir, dir, "references", `${r}.md`))) &&
        readdirSync(join(skillsDir, dir, "references")).filter((f) => f.endsWith(".md")).length === REFERENCES.length,
    );
    h.check(`${name}: listed in skills.sh.json`, registered.has(dir));
  }
  h.check("smoke matrix has no entry without a directory", h.SKILLS.every((s) => onDisk.includes(`${s}-delegate`)));
  h.check("skills.sh.json has no entry without a directory", [...registered].every((s) => onDisk.includes(s)));
}
