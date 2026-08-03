import { useState } from "react"
import { Bell, BedDouble, CalendarPlus, ChevronsUpDown, Menu, MessageCircle, PanelLeftClose, Settings, X } from "lucide-react"
import { ReservationScreen } from "./screens/ReservationScreen"
import { OperationsScreen } from "./screens/OperationsScreen"
import { CommunicationScreen } from "./screens/CommunicationScreen"

type View = "reservation" | "operations" | "communication"

const nav = [
  { id: "operations" as const, label: "Operação", description: "Chegadas e check-ins", icon: BedDouble },
  { id: "reservation" as const, label: "Nova reserva", description: "Cadastro manual", icon: CalendarPlus },
  { id: "communication" as const, label: "Comunicação", description: "Mensagens e hóspedes", icon: MessageCircle, count: 2 },
]

export default function App() {
  const [view, setView] = useState<View>("operations")
  const [menuOpen, setMenuOpen] = useState(false)
  const selectView = (next: View) => { setView(next); setMenuOpen(false) }
  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
      <header className="brand"><div className="brand-mark">Y</div><div><strong>YES HOTEL</strong><span>Operação inteligente</span></div><button className="icon-button close-menu" onClick={() => setMenuOpen(false)} aria-label="Fechar menu"><X /></button></header>
      <div className="property-switcher"><span className="property-icon"><BedDouble /></span><div><small>Propriedade</small><strong>Yes Hotel</strong></div><ChevronsUpDown /></div>
      <nav aria-label="Navegação principal"><span className="nav-label">Área de trabalho</span>{nav.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => selectView(item.id)}><item.icon /><span><strong>{item.label}</strong><small>{item.description}</small></span>{item.count && <b>{item.count}</b>}</button>)}</nav>
      <div className="sidebar-spacer" />
      <div className="mock-note"><span /> <div><strong>Ambiente de demonstração</strong><small>Dados fictícios e ações locais</small></div></div>
      <button className="profile-button"><span className="avatar">MR</span><span><strong>Marina Rocha</strong><small>Gerente de operações</small></span><Settings /></button>
    </aside>
    {menuOpen && <button className="mobile-overlay" onClick={() => setMenuOpen(false)} aria-label="Fechar menu" />}
    <main className="main-content"><header className="mobile-header"><button className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Abrir menu"><Menu /></button><div className="mobile-brand">YES HOTEL</div><button className="icon-button" aria-label="Notificações"><Bell /></button></header>{view === "reservation" && <ReservationScreen />}{view === "operations" && <OperationsScreen onOpenCommunication={() => selectView("communication")} />}{view === "communication" && <CommunicationScreen />}</main>
  </div>
}
