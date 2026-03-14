export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return response.status(500).json({
      error:
        "Missing required env vars: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY.",
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
