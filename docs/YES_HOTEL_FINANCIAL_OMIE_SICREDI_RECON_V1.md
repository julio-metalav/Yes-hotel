# Yes Hotel — Reconciliação Omie ↔ Sicredi V1.1

Motor determinístico (`rule_version=omie_sicredi_v1.1`). Sem IA, HITS, Stone, Pagar.me ou UI. Não persiste grupos/findings nesta rodada.

## Valor

Banco usa `gross_amount_cents`. Omie usa `settled_amount_cents`. Não assume `gross = settled + open`.

## Transferências internas

`sicredi_principal` ↔ `sicredi_0911`, valor exato, janela ≤ 1 dia, contraparte única. MEMO compatível só aumenta evidência (`memo_transfer_signal`); não é obrigatório. Múltiplas contrapartes → ambiguous. Não remove o fato; high exclui o banco do match Omie.

## Score 1:1

Direção obrigatória. Valor diferente não auto-match. `+50` valor exato, `+25/+18/+10` D0/D+1/D+2, `+25/+18/+10` exact/token/contains. `>=90` unique → high (`auto_matched` revisável). `75–89` → suggested. Empate → ambiguous (`finding_type=duplicate_possible`, note `ambiguous_match`).

## N:1

Camadas: pessoa+data (high) → pessoa+D+1 → lote do dia → lote D+1. Soma settled exata, N≤8, combinação única. Sem fuzzy de nome. Sem subset-sum do mês.

Limites de busca: máx. 16 candidatos/janela, 2048 combinações, 20ms/alvo, N≤8. Excesso → `grouping_search_limit`, unmatched. Nunca 1 Omie → N banco. Score 75 só valor+data continua suggested.

Ordem: transferências internas → 1:1 high → N:1 → 1:1 suggested → ambiguous → unmatched. Entry não é alocada duas vezes.

## Findings

`internal_transfer`, `duplicate_possible` (ambiguous), `payment_aggregation`, `partial_payment`, `value_mismatch` (identidade forte + valor diferente), `omie_without_bank`, `bank_without_omie`. Sem fraude.
