import { prisma } from "../src/db.js";

async function main() {
  // Always ensure the default LLM provider setting exists. Idempotent —
  // re-running the seed never overwrites an admin's chosen provider.
  await prisma.setting.upsert({
    where: { key: "llm.provider" },
    update: {},
    create: { key: "llm.provider", value: JSON.stringify("claude") },
  });

  // Users aren't seeded: in local single-user mode the local user is created
  // (as admin) on the first request; with feishu-sso, users self-provision on
  // first login and ADMIN_OPEN_IDS / ADMIN_EMAILS / ADMIN_PHONES pick the admins
  // (see src/utils/guards.ts).
  console.log("Seed complete.");
}

main().finally(() => prisma.$disconnect());
