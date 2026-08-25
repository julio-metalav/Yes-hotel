const PRODUCTION_REF = "minmmecajnmjqlgacfoz";

function projectRefFromUrl(url) {
  const match = String(url || "").match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return match ? match[1].toLowerCase() : "";
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const vercelEnv = String(process.env.VERCEL_ENV || "").toLowerCase();
  const supabaseUrl =
    process.env.YES_HOTEL_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const ref = projectRefFromUrl(supabaseUrl);

  if (vercelEnv === "preview" && (ref === PRODUCTION_REF || !ref)) {
    return response.status(503).json({
      error: "Preview isolado recusou backend de producao.",
    });
  }

  if (vercelEnv === "production" && ref && ref !== PRODUCTION_REF) {
    return response.status(503).json({
      error: "Producao recusou backend de homologacao.",
    });
  }

  const supabaseServiceRoleKey =
    vercelEnv === "preview"
      ? process.env.YES_HOTEL_SUPABASE_SERVICE_ROLE_KEY
      : process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return response.status(500).json({
      error:
        vercelEnv === "preview"
          ? "Preview isolado exige YES_HOTEL_SUPABASE_URL e YES_HOTEL_SUPABASE_SERVICE_ROLE_KEY."
          : "Missing required env vars: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY.",
    });
  }

  const upstreamResponse = await fetch(
    `${supabaseUrl}/rest/v1/usuarios_internos?select=id&limit=1`,
    {
      headers: {
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
      },
    },
  );

  if (!upstreamResponse.ok) {
    const details = await upstreamResponse.text();

    return response.status(500).json({
      error: "Failed to query bootstrap status.",
      details,
    });
  }

  const rows = await upstreamResponse.json();

  return response.status(200).json({
    hasUsers: Array.isArray(rows) && rows.length > 0,
  });
}
