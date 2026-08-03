import assert from "node:assert/strict";
import {
  FNRH_PUBLIC_DEFAULT_BASE_URL,
  buildFnrhPreenchimentoUrl,
  isForbiddenFnrhPublicHost,
  maskFnrhLinkForLog,
  maskFnrhTokensInText,
  normalizeFnrhPublicBaseUrl,
  resolveFnrhPublicBaseUrl,
} from "../supabase/functions/_shared/fnrh-public-link.ts";

const guestId = "5321a46f-5000-43e1-8830-df57f3bc0439";
const token = "tok_secreto_homolog_abc123";

// base com e sem barra final
{
  const a = buildFnrhPreenchimentoUrl(guestId, token, {
    baseUrl: "https://yes-hotel.vercel.app",
  });
  const b = buildFnrhPreenchimentoUrl(guestId, token, {
    baseUrl: "https://yes-hotel.vercel.app/",
  });
  assert.equal(a, b);
  assert.equal(
    a,
    `https://yes-hotel.vercel.app/fnrh-preenchimento.html?v=2&guest_id=${encodeURIComponent(guestId)}&token=${encodeURIComponent(token)}`,
  );
}

// parâmetros codificados (caracteres especiais)
{
  const specialGuest = "id/with spaces&x";
  const specialToken = "t=1&y=2";
  const url = buildFnrhPreenchimentoUrl(specialGuest, specialToken, {
    baseUrl: "https://yes-hotel.vercel.app",
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://yes-hotel.vercel.app");
  assert.equal(parsed.pathname, "/fnrh-preenchimento.html");
  assert.equal(parsed.searchParams.get("guest_id"), specialGuest);
  assert.equal(parsed.searchParams.get("token"), specialToken);
  assert.equal(parsed.searchParams.get("v"), "2");
  assert.match(url, /guest_id=id%2Fwith\+spaces%26x|guest_id=id%2Fwith%20spaces%26x/);
}

// impossível usar *.supabase.co como página pública
{
  assert.equal(isForbiddenFnrhPublicHost("minmmecajnmjqlgacfoz.supabase.co"), true);
  assert.equal(normalizeFnrhPublicBaseUrl("https://minmmecajnmjqlgacfoz.supabase.co"), null);
  assert.equal(
    normalizeFnrhPublicBaseUrl("https://minmmecajnmjqlgacfoz.supabase.co/"),
    null,
  );
  assert.equal(
    resolveFnrhPublicBaseUrl({
      override: "https://minmmecajnmjqlgacfoz.supabase.co",
      envValue: "https://also.supabase.co",
    }),
    FNRH_PUBLIC_DEFAULT_BASE_URL,
  );
  const url = buildFnrhPreenchimentoUrl(guestId, token, {
    baseUrl: "https://minmmecajnmjqlgacfoz.supabase.co",
    envValue: "",
  });
  assert.ok(url.startsWith("https://yes-hotel.vercel.app/fnrh-preenchimento.html"));
  assert.ok(!url.includes("supabase.co"));
}

// http e lixo rejeitados; env válido prevalece sobre override inválido
{
  assert.equal(normalizeFnrhPublicBaseUrl("http://yes-hotel.vercel.app"), null);
  assert.equal(normalizeFnrhPublicBaseUrl("not a url"), null);
  assert.equal(
    resolveFnrhPublicBaseUrl({
      override: "https://minmmecajnmjqlgacfoz.supabase.co",
      envValue: "https://yes-hotel.vercel.app/",
    }),
    "https://yes-hotel.vercel.app",
  );
}

// WhatsApp e e-mail usam a mesma URL correta
{
  const emailLink = buildFnrhPreenchimentoUrl(guestId, token, {
    envValue: "https://yes-hotel.vercel.app",
  });
  const whatsappLink = buildFnrhPreenchimentoUrl(guestId, token, {
    envValue: "https://yes-hotel.vercel.app",
  });
  assert.equal(emailLink, whatsappLink);
  const emailHtml = `<a href="${emailLink}">Abrir formulário FNRH</a>`;
  const whatsappText = `preencha sua FNRH pelo link:\n${whatsappLink}\n`;
  assert.ok(emailHtml.includes(emailLink));
  assert.ok(whatsappText.includes(whatsappLink));
  assert.ok(!emailLink.includes("supabase.co"));
}

// token não exposto em logs/preview
{
  const full = buildFnrhPreenchimentoUrl(guestId, token, {
    baseUrl: "https://yes-hotel.vercel.app",
  });
  const masked = maskFnrhLinkForLog(full);
  assert.ok(!masked.includes(token));
  assert.ok(masked.includes("token=to***") || masked.includes("token=***"));
  const preview = maskFnrhTokensInText(`FNRH link: ${full}\nSenha: 123456`);
  assert.ok(!preview.includes(token));
  assert.ok(preview.includes("123456")); // senha de acesso não é o token FNRH
}

console.log("ok: test-fnrh-public-link");
