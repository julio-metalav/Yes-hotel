import { useMemo, useState } from "react"
import { ArrowLeft, CheckCheck, FileText, Info, KeyRound, MoreHorizontal, Paperclip, Search, Send, Sparkles } from "lucide-react"
import { conversations, reservations } from "../data/mock-data"

const initialMessages = [
  { id: 1, side: "out", type: "auto", text: "Olá, Julio! Sua chegada ao Yes Hotel está próxima. Para agilizar o check-in, preencha os dados da FNRH pelo link enviado.", time: "09:05" },
  { id: 2, side: "in", type: "manual", text: "Bom dia! Já preenchi meus dados. Meu acompanhante está finalizando agora.", time: "10:31" },
  { id: 3, side: "out", type: "manual", text: "Perfeito, Julio. Assim que todos concluírem, enviaremos a senha de acesso ao apartamento.", time: "10:35" },
  { id: 4, side: "in", type: "manual", text: "Obrigado! Posso chegar às 16h?", time: "10:42" },
]

export function CommunicationScreen() {
  const [filter, setFilter] = useState<"todas" | "aberta" | "pendente" | "resolvida">("todas")
  const [activeId, setActiveId] = useState("c1")
  const [message, setMessage] = useState("")
  const [messages, setMessages] = useState(initialMessages)
  const [mobileChat, setMobileChat] = useState(false)
  const active = conversations.find((item) => item.id === activeId)!
  const stay = reservations.find((item) => item.id === active.reservationId)!
  const visible = useMemo(() => conversations.filter((item) => filter === "todas" || item.status === filter), [filter])

  function send() { if (!message.trim()) return; setMessages((items) => [...items, { id: Date.now(), side: "out", type: "manual", text: message.trim(), time: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) }]); setMessage("") }

  return <div className="communication-shell">
    <aside className={`conversation-list ${mobileChat ? "mobile-hidden" : ""}`}><header><div><span className="eyebrow">Atendimento</span><h1>Comunicação</h1></div><button className="icon-button" aria-label="Mais opções"><MoreHorizontal /></button></header><label className="search-box full"><Search /><input placeholder="Buscar conversas" /></label><div className="filter-pills">{(["todas", "aberta", "pendente", "resolvida"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "todas" ? "Todas" : `${item[0].toUpperCase()}${item.slice(1)}s`}</button>)}</div><div className="conversation-items">{visible.map((item) => <button className={`conversation-item ${activeId === item.id ? "active" : ""}`} key={item.id} onClick={() => { setActiveId(item.id); setMobileChat(true) }}><span className="avatar">{item.initials}</span><span className="conversation-copy"><span><strong>{item.name}</strong><time>{item.time}</time></span><small>Apto {item.apartment}</small><p>{item.preview}</p></span>{item.unread > 0 && <b className="unread">{item.unread}</b>}</button>)}</div></aside>
    <main className={`chat-panel ${mobileChat ? "mobile-visible" : ""}`}><header className="chat-header"><button className="icon-button mobile-back" onClick={() => setMobileChat(false)} aria-label="Voltar às conversas"><ArrowLeft /></button><span className="avatar">{active.initials}</span><div><h2>{active.name}</h2><p>Apto {active.apartment} · Check-in hoje</p></div><span className={`conversation-status ${active.status}`}>{active.status}</span><button className="icon-button"><MoreHorizontal /></button></header><div className="chat-messages"><div className="day-marker">Hoje</div>{messages.map((item) => <div className={`message ${item.side}`} key={item.id}>{item.type === "auto" && <span className="auto-label"><Sparkles /> Mensagem automática</span>}<p>{item.text}</p><time>{item.time} {item.side === "out" && <CheckCheck />}</time></div>)}</div><div className="quick-actions"><button onClick={() => setMessage("Olá! Segue sua senha de acesso: ")}><KeyRound /> Enviar senha</button><button onClick={() => setMessage("Olá! Para concluir sua FNRH, acesse: ")}><FileText /> Enviar FNRH</button><button onClick={() => setMessage("Olá! Confira as instruções para sua chegada: ")}><Info /> Instruções</button></div><footer className="composer"><button className="icon-button" aria-label="Anexar arquivo"><Paperclip /></button><textarea value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); send() } }} rows={1} placeholder="Digite uma mensagem" /><button className="send-button" onClick={send} aria-label="Enviar mensagem"><Send /></button></footer></main>
    <aside className="stay-summary"><header><span className="eyebrow">Hospedagem</span><h2>Resumo da reserva</h2></header><div className="summary-guest"><span className="avatar large">{stay.initials}</span><h3>{stay.guest}</h3><p>{stay.phone}</p></div><div className="summary-room"><span>Apartamento</span><strong>{stay.apartment}</strong></div><dl><div><dt>Check-in</dt><dd>{stay.checkIn}, {stay.time}</dd></div><div><dt>Check-out</dt><dd>{stay.checkOut}, 11:00</dd></div><div><dt>Hóspedes</dt><dd>{stay.guests} pessoas</dd></div><div><dt>Reserva</dt><dd>{stay.id}</dd></div></dl><section><h3>Status operacional</h3><p><span>Pagamento</span><b>{stay.payment}</b></p><p><span>FNRH</span><b>{stay.fnrh}</b></p><p><span>Acesso</span><b>{stay.access}</b></p></section><button className="button secondary full">Ver reserva completa</button></aside>
  </div>
}
