# Yes Hotel — Omie Contas a Receber / Pagar V1

Parser do pivot analítico Omie (`source_type=omie_ar_ap`, `omie_ar_ap@1.0.0`). Não é o pivot 3 de faturamento. Sem UI, conciliação, HITS ou classificação.

## Contrato observado no `pivot (4).xlsx`

Uma aba (`Contas por Cliente ou Forne…`), 2137×14, sem fórmulas, sem tabela Excel nativa.

| Linha | Papel |
|---|---|
| 1 | Título (merge A1:J1) |
| 2 | `Tipo` |
| 3 | `1. Contas a Receber` (C–F) / `2. Contas a Pagar` (G–J) / `Totais` (K–N) |
| 4 | Cabeçalhos |
| 5–2136 | Fatos (nome + data + valores) |
| 2137 | `Total geral` — não vira entry |

Colunas A–B: nome fantasia (com carry-forward) e `Data de Pagto ou Recbto` (`dd/mm/yyyy`).  
C–F = AR. G–J = AP (valores **negativos** no arquivo). K–N = AR+AP da linha (derivado; **não** vira entry).

Não existem no arquivo: ID/título Omie, documento, parcela, categoria, emissão, vencimento, conta bancária.

## Exclusões

Não viram `financial_entries`: título, seção, cabeçalho, `Total geral`, colunas K–N, linhas vazias.

## Mapping

| XLSX | Entry |
|---|---|
| bloco C–F | `omie_receivable` / `receivable` / `credit` |
| bloco G–J | `omie_payable` / `payable` / `debit` |
| Valor da Conta | `gross_amount_cents` (absoluto) |
| Impostos Retidos | `tax_cents` |
| Pago ou Recebido | `settled_amount_cents` |
| A Pagar ou Receber | `open_amount_cents` |
| Data de Pagto/Recbto | `settlement_date` |
| Nome fantasia | `person_name` |
| `net_amount_cents` | sempre null neste parser |
| `account_id` | null |

Linha com AR e AP gera **duas** entries (`source_row = linha*10+1` / `+2`).

## Dedup

Sem ID Omie: `source_record_id` fica null. Unicidade = `(source_import_id, source_row)`. `normalized_hash` é correlação e **não** elimina agregados iguais no mesmo dia.

## `settled_amount_cents`

Migration aditiva. Não reutilizamos `net_amount_cents`.

No pivot 4 real, AP liquidado pode diferir do bruto (imposto/ajuste). O parser preserva os três fatos e não cria finding.
