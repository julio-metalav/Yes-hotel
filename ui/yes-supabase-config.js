// Gerado por scripts/generate-yes-supabase-config.mjs.
// Nao colocar service_role neste arquivo. Preview x Production e definido no build.
window.YES_HOTEL_SUPABASE_CONFIG = {
  url: "https://minmmecajnmjqlgacfoz.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1pbm1tZWNham5tanFsZ2FjZm96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxOTc1OTUsImV4cCI6MjA4ODc3MzU5NX0.zyrDRTlU-yUKINegXDDsTlww4pPcAGIDn6hLq-FFA84",
  appSessionHours: 4,
  pagarmeUiEnabled: true,
  pagamentoPresencialDiferidoUiEnabled: true,
};
window.YES_HOTEL_SUPABASE_TARGET = "local";
(function isolateYesHotelSupabase(global) {
  var PRODUCTION_REF = "minmmecajnmjqlgacfoz";
  var PRODUCTION_HOST = "yes-hotel.vercel.app";
  var cfg = global.YES_HOTEL_SUPABASE_CONFIG;
  if (!cfg || !cfg.url) {
    return;
  }
  function projectRef(url) {
    var match = String(url).match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
    return match ? match[1].toLowerCase() : "";
  }
  function fail(message) {
    cfg.url = "";
    cfg.anonKey = "";
    throw new Error(message);
  }
  var ref = projectRef(cfg.url);
  var host = (global.location && global.location.hostname) || "";
  var isProdHost = host === PRODUCTION_HOST;
  var isVercelPreview = /\.vercel\.app$/i.test(host) && !isProdHost;
  if (isVercelPreview && ref === PRODUCTION_REF) {
    fail("Preview isolado recusou o project_ref de producao.");
  }
  if (isProdHost && ref && ref !== PRODUCTION_REF) {
    fail("Producao recusou o project_ref de homologacao.");
  }
  if (String(cfg.anonKey || "").indexOf("service_role") !== -1) {
    fail("service_role nao e permitida no frontend.");
  }
})(window);
