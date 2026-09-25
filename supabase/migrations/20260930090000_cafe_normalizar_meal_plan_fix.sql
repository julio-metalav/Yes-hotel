-- Café — hotfix da normalização de acentos do mealPlanDesc.
--
-- Sintoma em PROD: `operacional_cafe_normalizar_meal_plan('Café da Manhã')`
-- devolvia `café da manhã` (acentos intactos), então
-- `operacional_cafe_resolve_entitlement` não casava com a chave homologada
-- `cafe da manha` e classificava tudo como `nao_mapeado`.
--
-- Causa: a tabela de acentos do `translate` era escrita com os próprios
-- caracteres acentuados no SQL. Qualquer conversão de codificação no caminho
-- até o banco (editor, área de transferência, PowerShell lendo UTF-8 como ANSI)
-- corrompe esses literais, e o `translate` passa a procurar caracteres que não
-- existem na entrada — falhando em silêncio, sem erro.
--
-- Correção: os mesmos caracteres, escritos em escapes Unicode (`U&'\00E1'`).
-- O arquivo inteiro vira ASCII puro e fica imune a recodificação. A lógica é
-- idêntica à pretendida: lower → translate (só minúsculas acentuadas, porque
-- lower já foi aplicado) → colapsa espaços → btrim.
--
-- Escopo: só esta função. Não toca snapshot, HITS, FNRH, financeiro, senha,
-- TAG, scheduler, UI, nem as regras de entitlement. Sem backfill.

create or replace function public.operacional_cafe_normalizar_meal_plan(p_desc text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- Normaliza só para COMPARAR: espaços, caixa e acento. Mapeamento em escapes
  -- Unicode para não depender da codificação do arquivo:
  --   á à â ã ä  → a      é è ê ë → e      í ì î ï → i
  --   ó ò ô õ ö  → o      ú ù û ü → u      ç → c    ñ → n
  select btrim(regexp_replace(
    translate(
      lower(coalesce(p_desc, '')),
      U&'\00E1\00E0\00E2\00E3\00E4\00E9\00E8\00EA\00EB\00ED\00EC\00EE\00EF\00F3\00F2\00F4\00F5\00F6\00FA\00F9\00FB\00FC\00E7\00F1',
      'aaaaaeeeeiiiiooooouuuucn'
    ),
    '\s+', ' ', 'g'
  ));
$$;

comment on function public.operacional_cafe_normalizar_meal_plan(text) is
  'Normaliza mealPlanDesc apenas para comparacao (espacos, caixa, acento). A '
  'tabela de acentos usa escapes Unicode para resistir a recodificacao do arquivo. '
  'Espelha normalizeMealPlanDesc em cafe-meal-plan.ts.';

revoke all on function public.operacional_cafe_normalizar_meal_plan(text) from public, anon;
grant execute on function public.operacional_cafe_normalizar_meal_plan(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Autoverificação: se a normalização voltar errada (por codificação ou
-- qualquer outro motivo), a migration FALHA aqui em vez de deixar o café
-- classificando tudo como não identificado em silêncio.
-- As entradas de teste também vão em escapes Unicode.
-- ---------------------------------------------------------------------------
do $$
declare
  v_cafe  text := U&'Caf\00E9 da Manh\00E3';   -- "Café da Manhã"
  v_norm  text;
  v_kind  text;
  v_qtd   integer;
begin
  v_norm := public.operacional_cafe_normalizar_meal_plan(v_cafe);
  if v_norm <> 'cafe da manha' then
    raise exception 'normalizacao incorreta: esperado "cafe da manha", veio "%"', v_norm;
  end if;

  -- Maiúsculas acentuadas + espaços repetidos: "  CAFÉ   DA   MANHÃ  "
  if public.operacional_cafe_normalizar_meal_plan(U&'  CAF\00C9   DA   MANH\00C3  ') <> 'cafe da manha' then
    raise exception 'normalizacao nao tratou caixa/espacos repetidos';
  end if;

  if public.operacional_cafe_normalizar_meal_plan('Nenhum') <> 'nenhum' then
    raise exception 'normalizacao incorreta para "Nenhum"';
  end if;

  select e.cafe_kind, e.quantidade_direito into v_kind, v_qtd
  from public.operacional_cafe_resolve_entitlement(v_cafe, 2, 0) e;
  if v_kind <> 'incluido' or v_qtd <> 2 then
    raise exception 'entitlement incorreto para cafe incluido: kind=% qtd=%', v_kind, v_qtd;
  end if;

  select e.cafe_kind, e.quantidade_direito into v_kind, v_qtd
  from public.operacional_cafe_resolve_entitlement('Nenhum', 2, 0) e;
  if v_kind <> 'sem_cafe' or v_qtd <> 0 then
    raise exception 'entitlement incorreto para sem cafe: kind=% qtd=%', v_kind, v_qtd;
  end if;

  select e.cafe_kind, e.quantidade_direito into v_kind, v_qtd
  from public.operacional_cafe_resolve_entitlement(null, 2, 0) e;
  if v_kind <> 'nao_mapeado' or v_qtd <> 0 then
    raise exception 'entitlement incorreto para NULL: kind=% qtd=%', v_kind, v_qtd;
  end if;

  raise notice 'normalizacao do mealPlanDesc OK (cafe/sem cafe/NULL conferidos)';
end;
$$;
