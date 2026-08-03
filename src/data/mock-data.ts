export type Reservation = {
  id: string
  apartment: string
  guest: string
  initials: string
  checkIn: string
  checkOut: string
  time: string
  guests: number
  payment: "Pago" | "Pendente"
  fnrh: "Completa" | "Pendente" | "Enviada"
  access: "Ativo" | "Pendente" | "Bloqueado"
  communication: "Respondido" | "Aguardando" | "Automático"
  phone: string
  email: string
  password: string
  note: string
}

export const reservations: Reservation[] = [
  { id: "YH-2418", apartment: "12", guest: "Julio César", initials: "JC", checkIn: "Hoje, 15 mar", checkOut: "18 mar", time: "14:00", guests: 3, payment: "Pago", fnrh: "Pendente", access: "Pendente", communication: "Aguardando", phone: "+55 11 99999-0001", email: "julio@email.com", password: "—", note: "Chegada prevista após as 16h. Veículo prata, placa ABC1D23." },
  { id: "YH-2419", apartment: "18", guest: "Sandra Maria", initials: "SM", checkIn: "Hoje, 15 mar", checkOut: "18 mar", time: "15:30", guests: 2, payment: "Pendente", fnrh: "Enviada", access: "Bloqueado", communication: "Respondido", phone: "+55 11 98888-0000", email: "sandra@email.com", password: "—", note: "Aguardando confirmação do pagamento na recepção." },
  { id: "YH-2420", apartment: "24", guest: "João Pedro", initials: "JP", checkIn: "Hoje, 15 mar", checkOut: "18 mar", time: "13:00", guests: 3, payment: "Pago", fnrh: "Completa", access: "Ativo", communication: "Automático", phone: "+55 11 97777-0000", email: "joao@email.com", password: "482913", note: "Acesso liberado. Hóspede já recebeu as instruções." },
  { id: "YH-2421", apartment: "07", guest: "Ana Souza", initials: "AS", checkIn: "Hoje, 15 mar", checkOut: "17 mar", time: "18:00", guests: 2, payment: "Pago", fnrh: "Pendente", access: "Pendente", communication: "Aguardando", phone: "+55 21 96666-1212", email: "ana@email.com", password: "—", note: "Reserva recebida por agência. Confirmar dados do acompanhante." },
]

export type Conversation = {
  id: string
  reservationId: string
  name: string
  initials: string
  apartment: string
  preview: string
  time: string
  unread: number
  status: "aberta" | "pendente" | "resolvida"
}

export const conversations: Conversation[] = [
  { id: "c1", reservationId: "YH-2418", name: "Julio César", initials: "JC", apartment: "12", preview: "Obrigado! Posso chegar às 16h?", time: "10:42", unread: 2, status: "pendente" },
  { id: "c2", reservationId: "YH-2419", name: "Sandra Maria", initials: "SM", apartment: "18", preview: "Vou realizar o pagamento agora.", time: "09:18", unread: 0, status: "aberta" },
  { id: "c3", reservationId: "YH-2420", name: "João Pedro", initials: "JP", apartment: "24", preview: "Senha de acesso enviada", time: "Ontem", unread: 0, status: "resolvida" },
  { id: "c4", reservationId: "YH-2421", name: "Ana Souza", initials: "AS", apartment: "07", preview: "Precisamos dos dados do acompanhante.", time: "Ontem", unread: 1, status: "pendente" },
]
