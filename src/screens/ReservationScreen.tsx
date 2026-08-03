import { useState } from "react"
import { ChevronDown, Plus, Trash2, Upload, WandSparkles } from "lucide-react"

type Companion = { id: number; name: string; document: string }

export function ReservationScreen() {
  const [companions, setCompanions] = useState<Companion[]>([{ id: 1, name: "", document: "" }])
  const [importOpen, setImportOpen] = useState(false)
  const [notice, setNotice] = useState("")

  function save(message: string) {
    setNotice(message)
    window.setTimeout(() => setNotice(""), 3000)
  }

  return (
    <div className="screen reservation-screen">
      <header className="page-heading">
        <div><span className="eyebrow">Reservas</span><h1>Nova reserva manual</h1><p>Cadastre uma hospedagem e deixe a operação pronta para receber o hóspede.</p></div>
        <span className="context-chip"><WandSparkles /> Preenchimento assistido</span>
      </header>

      {notice && <div className="toast" role="status">{notice}</div>}

      <form className="reservation-form" onSubmit={(event) => { event.preventDefault(); save("Reserva salva com sucesso.") }}>
        <section className="form-section">
          <div className="section-heading"><span>01</span><div><h2>Dados da estadia</h2><p>Informações básicas para organizar a chegada.</p></div></div>
          <div className="form-grid cols-4">
            <label>Origem da reserva<select defaultValue="Direta"><option>Direta</option><option>Booking.com</option><option>Hospedin</option><option>Agência</option></select></label>
            <label>Código externo<input placeholder="Ex.: BK-839201" /></label>
            <label>Apartamento<select defaultValue="12">{Array.from({ length: 40 }, (_, i) => String(i + 1).padStart(2, "0")).map((room) => <option key={room}>{room}</option>)}</select></label>
            <label>Nº de hóspedes<input type="number" min="1" max="8" defaultValue="2" /></label>
            <label>Check-in<input type="date" defaultValue="2026-08-03" /></label>
            <label>Horário previsto<input type="time" defaultValue="14:00" /></label>
            <label>Check-out<input type="date" defaultValue="2026-08-05" /></label>
            <label>Horário previsto<input type="time" defaultValue="11:00" /></label>
          </div>
        </section>

        <section className="form-section">
          <div className="section-heading"><span>02</span><div><h2>Hóspede principal</h2><p>Contato que receberá confirmações e dados de acesso.</p></div></div>
          <div className="form-grid cols-3">
            <label className="span-2">Nome completo<input required placeholder="Nome do hóspede" /></label>
            <label>CPF ou passaporte<input placeholder="000.000.000-00" /></label>
            <label>WhatsApp<input required type="tel" placeholder="(11) 99999-9999" /></label>
            <label className="span-2">E-mail<input type="email" placeholder="hospede@email.com" /></label>
          </div>
        </section>

        <section className="form-section">
          <div className="section-heading between"><div className="section-heading"><span>03</span><div><h2>Hóspedes adicionais</h2><p>Identifique os acompanhantes para agilizar a FNRH.</p></div></div><button className="button secondary small" type="button" onClick={() => setCompanions((items) => [...items, { id: Date.now(), name: "", document: "" }])}><Plus /> Adicionar</button></div>
          <div className="companions-list">{companions.map((item, index) => <div className="companion-row" key={item.id}><span className="companion-number">{String(index + 1).padStart(2, "0")}</span><label>Nome completo<input value={item.name} onChange={(e) => setCompanions((items) => items.map((current) => current.id === item.id ? { ...current, name: e.target.value } : current))} placeholder="Nome do acompanhante" /></label><label>CPF ou passaporte<input value={item.document} onChange={(e) => setCompanions((items) => items.map((current) => current.id === item.id ? { ...current, document: e.target.value } : current))} placeholder="Documento" /></label><button className="icon-button" type="button" aria-label={`Remover hóspede ${index + 1}`} onClick={() => setCompanions((items) => items.filter((current) => current.id !== item.id))}><Trash2 /></button></div>)}</div>
        </section>

        <section className="form-section">
          <div className="section-heading"><span>04</span><div><h2>Operação e observações</h2><p>Detalhes importantes para a equipe.</p></div></div>
          <div className="form-grid cols-3"><label>Pagamento<select><option>Pago</option><option>Pendente</option><option>Pagamento no local</option></select></label><label>Placa do veículo<input placeholder="ABC1D23" /></label><label>Cor do veículo<input placeholder="Prata" /></label><label className="span-3">Observações<textarea rows={4} placeholder="Preferências, horário de chegada ou instruções especiais..." /></label></div>
        </section>

        <section className="import-panel"><button type="button" className="import-trigger" onClick={() => setImportOpen(!importOpen)}><span><Upload /> Importar dados por JSON <small>Opção avançada para integrações e testes</small></span><ChevronDown className={importOpen ? "rotate" : ""} /></button>{importOpen && <div className="import-body"><textarea rows={7} spellCheck={false} defaultValue={'{\n  "apartamento": "12",\n  "hospede": "Nome completo"\n}'} /><button type="button" className="button secondary">Validar e preencher</button></div>}</section>

        <footer className="form-footer"><button className="button ghost" type="reset">Cancelar</button><div><button className="button secondary" type="submit">Salvar reserva</button><button className="button primary" type="button" onClick={() => save("Reserva salva e check-in preparado.")}>Salvar e preparar check-in</button></div></footer>
      </form>
    </div>
  )
}
