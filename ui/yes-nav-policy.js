/**
 * Fonte única de verdade para menu lateral e proteção de rotas por perfil.
 * Reutilizada por todas as páginas operacionais para evitar que cada uma
 * mantenha sua própria lista de itens de menu (o problema que motivou este
 * módulo: o menu mudava dependendo da página aberta).
 */
(function attachYesHotelNavPolicy(globalScope) {
  const ICONS = {
    inicio: '<path d="M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6" />',
    checkin: '<path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />',
    cafe: '<path d="M17 8h1a3 3 0 1 1 0 6h-1M3 8h14v7a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Zm3-6v3M10 2v3M14 2v3" />',
    gestao: '<path d="M3 3v18h18M7 16v-5M12 16V8M17 16v-9" />',
    financeiro: '<path d="M12 3v18M4 8h6l-2.5 5H4Zm10 0h6l-2.5 5H14Z" />',
    minhasDemandas: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM22 11h-6M22 16h-6" />',
    demandas: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6v4H9zM8 12h8M8 16h5" />',
    demandar: '<path d="M12 5v14M5 12h14" />',
    wifi: '<path d="M5 12.5a12 12 0 0 1 14 0" /><path d="M8.5 16a7 7 0 0 1 7 0" /><path d="M12 19.5h.01" />',
    geo: '<path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" /><circle cx="12" cy="10" r="2.2" />',
    usuarios: '<path d="M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" /><circle cx="9.5" cy="7" r="4" /><path d="M17 11v6M14 14h6" />',
  };

  // Cada item de menu aponta para um routeKey — a mesma chave usada em
  // isRouteAuthorized/ROUTE_ACCESS, para que menu e proteção de rota nunca
  // divirjam (a mesma fonte decide o que aparece e o que é permitido).
  const NAV_ITEMS = {
    inicio: { routeKey: "inicio", label: "Início", href: "./usuarios-login-mvp.html", icon: ICONS.inicio },
    operacao: { routeKey: "checkin", label: "Operação", href: "./checkin-operacional-mvp.html", icon: ICONS.checkin },
    "checkin-hits": { routeKey: "checkin", label: "Check-in", href: "./checkin-operacional-mvp.html", icon: ICONS.checkin },
    cafe: { routeKey: "cafe", label: "Café da manhã", href: "./cafe-da-manha-mvp.html", icon: ICONS.cafe },
    gestao: { routeKey: "gestao", label: "Gestão", href: "./gestao-saude-hotel.html", icon: ICONS.gestao },
    financeiro: { routeKey: "financeiro", label: "Conciliação", href: "./financeiro-conciliacao.html", icon: ICONS.financeiro },
    "minhas-demandas": { routeKey: "demandas", label: "Minhas demandas", href: "./demandas-mvp.html?escopo=minhas", icon: ICONS.minhasDemandas },
    demandas: { routeKey: "demandas", label: "Demandas", href: "./demandas-mvp.html", icon: ICONS.demandas },
    demandar: { routeKey: "demandas", label: "Demandar", href: "./demandas-mvp.html?escopo=minhas&novo=1", icon: ICONS.demandar },
    wifi: { routeKey: "wifi", label: "Wi-Fi dos apartamentos", href: "./apartamentos-wifi-mvp.html", icon: ICONS.wifi },
    geo: { routeKey: "geo", label: "Geolocalização do hotel", href: "./geolocalizacao-hotel-mvp.html", icon: ICONS.geo },
    usuarios: { routeKey: "usuarios", label: "Usuários", href: "./usuarios-login-mvp.html#usuarios", icon: ICONS.usuarios },
  };

  // Conjunto e ORDEM exatos de itens de menu por perfil — fonte de verdade
  // única (matriz definitiva). Qualquer página que renderize o menu lateral
  // deve usar getNavItemsForRole, nunca uma lista própria.
  const ROLE_MENU_KEYS = {
    admin: ["inicio", "operacao", "cafe", "gestao", "financeiro", "minhas-demandas", "demandas"],
    recepcao: ["inicio", "operacao", "cafe", "gestao", "financeiro", "minhas-demandas", "demandas"],
    cafe: ["cafe", "minhas-demandas", "demandar"],
    hits_consulta: ["checkin-hits"],
  };

  // Rotas (routeKey) que cada perfil pode abrir diretamente por URL — usada
  // pelo guard de cada página, não só para esconder itens de menu.
  const ROUTE_ACCESS = {
    admin: ["inicio", "checkin", "cafe", "gestao", "financeiro", "demandas", "wifi", "geo", "hotel", "mensagens", "usuarios"],
    recepcao: ["inicio", "checkin", "cafe", "gestao", "financeiro", "demandas", "wifi", "geo", "hotel", "mensagens"],
    cafe: ["cafe", "demandas"],
    hits_consulta: ["checkin"],
  };

  function getNavItemsForRole(role) {
    const keys = ROLE_MENU_KEYS[role] || [];
    return keys.map((key) => ({ key, ...NAV_ITEMS[key] }));
  }

  function isRouteAuthorized(role, routeKey) {
    const allowed = ROUTE_ACCESS[role];
    return Array.isArray(allowed) && allowed.includes(routeKey);
  }

  function getHomeHrefForRole(role) {
    const items = getNavItemsForRole(role);
    return items.length > 0 ? items[0].href : "./usuarios-login-mvp.html";
  }

  /**
   * Substitui o conteúdo de um <nav> de sidebar pelos itens autorizados do
   * perfil, na ordem canônica, marcando o item cuja key bate com
   * activeItemKey como ativo (a key do item, não a rota — duas entradas de
   * menu podem apontar para a mesma rota com escopos diferentes, ex.:
   * "Minhas demandas" vs. "Demandas"). Preserva a marcação/estrutura
   * existente (mesmas classes de ícone) — sem redesign visual.
   */
  function renderSidebarNav(navElement, role, activeItemKey) {
    if (!navElement) {
      return;
    }
    const items = getNavItemsForRole(role);
    const labelHtml = '<span class="yes-sidebar-label">Áreas operacionais</span>';
    const linksHtml = items
      .map((item) => {
        const isActive = item.key === activeItemKey;
        const activeAttrs = isActive ? ' class="active" aria-current="page"' : "";
        return (
          `<a href="${item.href}" data-nav="${item.routeKey}"${activeAttrs}>` +
          `<svg viewBox="0 0 24 24" aria-hidden="true">${item.icon}</svg>` +
          `<span>${item.label}</span>` +
          `</a>`
        );
      })
      .join("");
    navElement.innerHTML = labelHtml + linksHtml;
  }

  globalScope.YesHotelNavPolicy = {
    getNavItemsForRole,
    isRouteAuthorized,
    getHomeHrefForRole,
    renderSidebarNav,
  };
})(window);
