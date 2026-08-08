/**
 * Redireciona rotas operacionais descontinuadas (Nova reserva / Comunicação)
 * para a home autorizada do perfil, sem carregar as UIs antigas.
 */
(async function redirectDeprecatedOperacionalRoute() {
  const loginUrl = "./usuarios-login-mvp.html";
  const checkinUrl = "./checkin-operacional-mvp.html";
  const cafeUrl = "./cafe-da-manha-mvp.html";
  const auth = window.YesHotelAuthApp;

  try {
    if (!auth || typeof auth.isConfigured !== "function" || !auth.isConfigured()) {
      window.location.replace(loginUrl);
      return;
    }

    const currentUser = await auth.getCurrentUser();
    if (!currentUser) {
      window.location.replace(loginUrl);
      return;
    }

    if (currentUser.role === "cafe") {
      window.location.replace(cafeUrl);
      return;
    }

    window.location.replace(checkinUrl);
  } catch (_error) {
    window.location.replace(loginUrl);
  }
})();
