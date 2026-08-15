# Yes Hotel — Reconciliação Omie ↔ Sicredi V1.2

Motor determinístico (`rule_version=omie_sicredi_v1.2`). Sem IA, HITS, Stone, Pagar.me ou UI.

Persistência HIGH (HOMO only): `--persist-high --allow-homo-reconciliation` (plano completo) ou `--persist-high-delta --allow-homo-reconciliation` (somente keys ainda ausentes). Somente transfer high + 1:1 high (`status=auto_matched`, revisável). Suggested/ambiguous/C/D/findings não entram. Idempotência por `reconciliation_key`. PROD aborta.

Contrato live Jan–Jul (facts atuais): analysis recomputa **601** high / R$ 708.211,87. Persistido: **601** high + 2 transfers. Delta **0**. Suggested 819 / ambiguous 20.

## Valor

Banco usa `gross_amount_cents`. Omie usa `settled_amount_cents`. Não assume `gross = settled + open`.

## Transferências internas

`sicredi_principal` ↔ `sicredi_0911`, valor exato, janela ≤ 1 dia, contraparte única. MEMO compatível só aumenta evidência (`memo_transfer_signal`); não é obrigatório. Múltiplas contrapartes → ambiguous. High exclui o banco do match Omie.

## Score 1:1

Direção obrigatória. Valor diferente não auto-match. `+50` valor exato, `+25/+18/+10` D0/D+1/D+2, `+25/+18/+10` exact/token/contains. `>=90` unique → high (`auto_matched` revisável). `75–89` unique → suggested (consome o par no dry-run, não confirma). Empate → ambiguous, **não consome**. Score 75 só valor+data continua suggested.

## N:1 oficial

Somente depois dos 1:1.

- A: mesma pessoa + mesma data + soma exata + combinação única + N≤8 → high
- B: mesma pessoa + D0/D+1 + soma exata + combinação única → suggested

Sem fuzzy. Sem deslocar 1:1 já alocado.

## Diagnóstico C/D

Lote por data / D+1 com pessoas diferentes **não cria match**. Gera `possible_aggregation` em memória, sem consumir entries nem reduzir unmatched.

## Limites

N≤8, máx. 24 candidatos, 8192 combinações. Sem timeout de parede. Excesso A/B → `grouping_search_limit`, unmatched. Nunca 1 Omie → N banco.

## Ordem

transferências → 1:1 high → 1:1 suggested → 1:1 ambiguous (sem consumir) → N:1 A → N:1 B → diagnóstico C/D → unmatched.

## Findings

`internal_transfer`, `duplicate_possible` (ambiguous), `payment_aggregation` (só A/B oficiais), `partial_payment`, `value_mismatch`, `omie_without_bank`, `bank_without_omie`. Diagnóstico C/D não vira finding persistível.
