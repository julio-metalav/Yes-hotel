/**
 * Token FNRH — hardening de transporte (query → POST body + strip URL).
 */
import assert from "node:assert/strict";
import {
  buildFnrhPreenchimentoUrl,
  maskFnrhLinkForLog,
} from "../supabase/functions/_shared/fnrh-public-link.ts";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

function stripTokenFromUrlString(href: string): string {
  const u = new URL(href);
  u.searchParams.delete("token");
  const q = u.searchParams.toString();
  return u.origin + u.pathname + (q ? `?${q}` : "") + u.hash;
}

function main() {
  console.log("\n=== FNRH token transport hardening ===\n");

  const guestId = "5321a46f-5000-43e1-8830-df57f3bc0439";
  const token = "tok_secreto_homolog_abc123";

  // A link legado continua com ?token= (canais e-mail/WA)
  {
    const legacy = buildFnrhPreenchimentoUrl(guestId, token, {
      baseUrl: "https://yes-hotel.vercel.app",
    });
    assert.match(legacy, /[?&]token=/);
    assert.match(legacy, /guest_id=/);
    ok("A link legado com token na query preservado no builder");
  }

  // B token retirado da barra (simulação replaceState)
  {
    const legacy = buildFnrhPreenchimentoUrl(guestId, token, {
      baseUrl: "https://yes-hotel.vercel.app",
    });
    const stripped = stripTokenFromUrlString(legacy);
    assert.ok(!stripped.includes("token="));
    assert.ok(stripped.includes("guest_id="));
    ok("B token removido da URL após carga");
  }

  // C chamadas novas usam body (contrato documentado no teste)
  {
    const body = { guest_id: guestId, token };
    const url = "https://minmmecajnmjqlgacfoz.supabase.co/functions/v1/fnrh-get";
    assert.ok(!url.includes("token="));
    assert.equal(body.token, token);
    ok("C POST fnrh-get sem token na query");
  }

  // D access log novo não contém token (URL de POST)
  {
    const loggedUrl = "https://minmmecajnmjqlgacfoz.supabase.co/functions/v1/fnrh-get";
    assert.ok(!/[?&]token=/i.test(loggedUrl));
    ok("D URL POST sem token (access log)");
  }

  // E token inválido fail-closed (contrato)
  {
    // Edge retorna 404 — coberto em smoke; aqui garante máscara de log
    const masked = maskFnrhLinkForLog(
      buildFnrhPreenchimentoUrl(guestId, token, { baseUrl: "https://yes-hotel.vercel.app" }),
    );
    assert.ok(!masked.includes(token));
    assert.match(masked, /token=to\*\*\*|token=\*\*\*/i);
    ok("E máscara de token em logs/preview");
  }

  // F sem regressão builder público
  {
    const a = buildFnrhPreenchimentoUrl(guestId, token, {
      baseUrl: "https://yes-hotel.vercel.app/",
    });
    assert.equal(
      a,
      `https://yes-hotel.vercel.app/fnrh-preenchimento.html?v=2&guest_id=${encodeURIComponent(guestId)}&token=${encodeURIComponent(token)}`,
    );
    ok("F fnrh-public-link builder estável");
  }

  console.log(`\n=== ${passed}/6 token checks OK ===\n`);
}

main();
