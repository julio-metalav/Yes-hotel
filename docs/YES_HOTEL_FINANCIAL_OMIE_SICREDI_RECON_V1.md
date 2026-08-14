# Yes Hotel — Reconciliação Omie ↔ Sicredi V1

Motor determinístico (`rule_version=omie_sicredi_v1`). Sem IA, HITS, Stone, Pagar.me ou UI. Não persiste grupos/findings nesta V1.

## Valor

Banco usa `gross_amount_cents`. Omie usa `settled_amount_cents`. Não assume `gross = settled + open`.

## Transferências internas

`sicredi_principal` ↔ `sicredi_0911`, valor exato, janela ≤ 1 dia, descrição compatível (TRANSF/TED/PIX/DOC/TEV/ENTRE CONTAS) quando houver texto. High se contraparte única. Não remove o fato; só exclui o banco do match Omie.

## Score 1:1

Direção obrigatória. Valor diferente não auto-match. `+50` valor exato, `+25/+18/+10` D0/D+1/D+2, `+25/+18/+10` exact/token/contains. `>=90` unique → high (`auto_matched` revisável). `75–89` → suggested. Empate → ambiguous (`finding_type=duplicate_possible`, note `ambiguous_match`).

## 1:N

Só grupos naturais (mesma pessoa normalizada + mesmo dia Omie, N≤10) cuja soma settled = 1 banco. Nunca 1 Omie → N banco.

## Findings

`internal_transfer`, `duplicate_possible` (ambiguous), `payment_aggregation`, `partial_payment`, `value_mismatch` (identidade forte + valor diferente), `omie_without_bank`, `bank_without_omie`. Sem fraude.
