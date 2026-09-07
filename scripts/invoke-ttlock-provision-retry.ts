/**
 * Dispara uma vez o worker fase 2 (mesmo path do cron).
 * Uso: npx tsx scripts/invoke-ttlock-provision-retry.ts
 */
import { execSync } from "node:child_process";

const PROJECT_REF = "minmmecajnmjqlgacfoz";

function loadServiceRole(): { url: string; key: string } {
  const raw = execSync(
    `npx supabase projects api-keys --project-ref ${PROJECT_REF} --reveal -o json`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const keys = JSON.parse(raw) as Array<{ name?: string; api_key?: string }>;
  const service = keys.find((k) => k.name === "service_role");
  if (!service?.api_key) throw new Error("service_role ausente");
  return { url: `https://${PROJECT_REF}.supabase.co`, key: service.api_key };
}

async function main() {
  const { url, key } = loadServiceRole();
  const res = await fetch(`${url}/functions/v1/ttlock-provision-retry`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      apikey: key,
    },
    body: JSON.stringify({ limit: 5 }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(JSON.stringify({ http: res.status, body }, null, 2));
  if (!res.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
