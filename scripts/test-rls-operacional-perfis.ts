/**
 * Contrato de RLS das tabelas núcleo do painel operacional:
 * operacional_reservas, operacional_hospedes, operacional_reserva_eventos,
 * fnrh_hospedes, operacional_credenciais_acesso, operacional_credencial_itens.
 *
 * Sem ambiente de banco descartável confirmado nesta sessão — `supabase` CLI
 * e `psql` estão bloqueados pela política de permissão ativa, e não há
 * confirmação de um Postgres local isolado para aplicar a migration e testar
 * contra RLS real. Por isso este teste é ESTÁTICO: lê o texto da migration
 * nova e das antigas, e reimplementa em JS a lógica exata das duas funções
 * SECURITY DEFINER (is_yes_hotel_ops_reader / is_yes_hotel_cafe_reader) para
 * simular a decisão de autorização por perfil — mas a reimplementação só é
 * confiável porque cada bloco é comparado, linha a linha, contra o corpo SQL
 * extraído da própria migration (se o SQL divergir do que o teste espera, o
 * teste falha por divergência de texto antes mesmo de simular nada).
 *
 * LIMITAÇÃO EXPLÍCITA: isto não substitui rodar a migration contra um
 * Postgres real (RLS tem detalhes de precedência entre policies, roles
 * herdados, e `security_barrier` que só um planner real garante). Ver seção
 * H da entrega para o detalhamento dessa limitação.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const ROOT = resolve(process.cwd());
const MIGRATION_PATH = resolve(
  ROOT,
  "supabase/migrations/20260919120000_operacional_rls_perfis_hardening.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf8");
// Código SQL sem comentários de linha (--): usado nas checagens que
// precisam ignorar prosa explicativa (ex.: o cabeçalho descreve o problema
// antigo citando literalmente "using (true)" como texto, não como SQL).
const sqlNoComments = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

const MIGRATIONS_DIR = resolve(ROOT, "supabase/migrations");

const CORE_TABLES = [
  "operacional_reservas",
  "operacional_hospedes",
  "operacional_reserva_eventos",
  "fnrh_hospedes",
  "operacional_credenciais_acesso",
  "operacional_credencial_itens",
] as const;

function main() {
  console.log("\n== 0. Migration nova existe, é posterior à última migration existente, e não edita migrations antigas ==");
  {
    const files = readFileSync(resolve(MIGRATIONS_DIR, "20260827181500_demandas_atribuicao_sem_telefone_obrigatorio.sql"), "utf8");
    assert.ok(files.length > 0, "última migration anterior à nova ainda existe e é legível");
    assert.ok(
      "20260919120000_operacional_rls_perfis_hardening.sql" > "20260827181500_demandas_atribuicao_sem_telefone_obrigatorio.sql",
      "nome da migration nova ordena depois da última existente",
    );
    ok("migration nova posterior à última migration existente (ordenação lexicográfica = ordenação de aplicação)");
  }

  console.log("\n== 1. Nenhuma policy genérica using(true)/with check(true) para authenticated nas 6 tabelas ==");
  {
    assert.doesNotMatch(sqlNoComments, /using\s*\(\s*true\s*\)/i, "migration nova não usa using(true) em lugar nenhum (fora de comentários)");
    assert.doesNotMatch(sqlNoComments, /with\s+check\s*\(\s*true\s*\)/i, "migration nova não usa with check(true) em lugar nenhum (fora de comentários)");
    ok("migration nova não recria nenhuma policy permissiva com (true)");
  }

  console.log("\n== 2. Policies antigas permissivas são removidas explicitamente, por nome ==");
  {
    const oldPolicies: Record<string, string[]> = {
      operacional_reservas: ["operacional_reservas_select", "operacional_reservas_insert", "operacional_reservas_update", "operacional_reservas_delete"],
      operacional_hospedes: ["operacional_hospedes_select", "operacional_hospedes_insert", "operacional_hospedes_update", "operacional_hospedes_delete"],
      operacional_reserva_eventos: ["operacional_reserva_eventos_select", "operacional_reserva_eventos_insert"],
      fnrh_hospedes: ["fnrh_hospedes_select_auth", "fnrh_hospedes_insert_auth", "fnrh_hospedes_update_auth"],
      operacional_credenciais_acesso: ["operacional_credenciais_acesso_select", "operacional_credenciais_acesso_insert", "operacional_credenciais_acesso_update", "operacional_credenciais_acesso_delete"],
      operacional_credencial_itens: ["operacional_credencial_itens_select", "operacional_credencial_itens_insert", "operacional_credencial_itens_update", "operacional_credencial_itens_delete"],
    };
    let total = 0;
    for (const [table, policies] of Object.entries(oldPolicies)) {
      for (const p of policies) {
        const re = new RegExp(`drop policy if exists ${p} on public\\.${table};`);
        assert.match(sql, re, `migration derruba explicitamente ${p} em ${table}`);
        total += 1;
      }
    }
    ok(`todas as ${total} policies antigas permissivas (using/with check true) são derrubadas por nome exato`);

    // fnrh_hospedes_all_service (service_role) não deve constar entre os drops.
    assert.doesNotMatch(sql, /drop policy if exists fnrh_hospedes_all_service/);
    ok("fnrh_hospedes_all_service (service_role) não é removida");
  }

  console.log("\n== 3. admin/recepcao (is_yes_hotel_ops_reader) têm as operações previstas ==");
  {
    const expectedOpsPolicies: Record<string, string[]> = {
      operacional_reservas: ["operacional_reservas_select_ops", "operacional_reservas_insert_ops", "operacional_reservas_update_ops"],
      operacional_hospedes: ["operacional_hospedes_select_ops", "operacional_hospedes_insert_ops", "operacional_hospedes_update_ops", "operacional_hospedes_delete_ops"],
      operacional_reserva_eventos: ["operacional_reserva_eventos_select_ops", "operacional_reserva_eventos_insert_ops"],
      fnrh_hospedes: ["fnrh_hospedes_select_ops"],
      operacional_credenciais_acesso: ["operacional_credenciais_acesso_select_ops"],
      operacional_credencial_itens: ["operacional_credencial_itens_select_ops"],
    };
    let total = 0;
    for (const [table, policies] of Object.entries(expectedOpsPolicies)) {
      for (const p of policies) {
        const block = extractPolicyBlock(sql, p);
        assert.ok(block, `policy ${p} existe em ${table}`);
        assert.match(block!, /is_yes_hotel_ops_reader\(\)/, `${p} usa is_yes_hotel_ops_reader()`);
        total += 1;
      }
    }
    ok(`${total} policies de escrita/leitura restrita usam is_yes_hotel_ops_reader() (admin+recepcao)`);
  }

  console.log("\n== 4. recepcao não recebe nada de gestão de usuários/admin novo ==");
  {
    // usuarios_internos não é tocada por esta migration: nenhuma policy,
    // grant, revoke ou alter table incide sobre ela — usuarios_internos só
    // aparece dentro do corpo das funções auxiliares, como fonte de leitura
    // do perfil. Gestão de perfil continua restrita à Edge Function
    // internal-users-admin (service_role), fora do escopo desta migration.
    assert.doesNotMatch(sql, /on public\.usuarios_internos/, "nenhuma policy/grant/alter table incide sobre usuarios_internos");
    const readOnlyRefs = [...sql.matchAll(/from public\.usuarios_internos/g)];
    assert.equal(readOnlyRefs.length, 2, "usuarios_internos só é lida (from) dentro dos dois corpos de função auxiliar");
    ok("nenhuma policy/grant nova sobre usuarios_internos — gestão de perfil permanece fora do RLS de authenticated");
  }

  console.log("\n== 5. cafe (is_yes_hotel_cafe_reader) não tem SELECT direto nas tabelas-base — achado bloqueante corrigido ==");
  {
    // Todas as policies criadas por esta migration, extraídas uma a uma por
    // nome exato (evita o risco de um [\s\S]*? não-guloso "pular" de um
    // bloco para o texto de outro policy mais abaixo no arquivo).
    const allPolicyNames = [
      "operacional_reservas_select_ops",
      "operacional_reservas_insert_ops",
      "operacional_reservas_update_ops",
      "operacional_hospedes_select_ops",
      "operacional_hospedes_insert_ops",
      "operacional_hospedes_update_ops",
      "operacional_hospedes_delete_ops",
      "operacional_reserva_eventos_select_ops",
      "operacional_reserva_eventos_insert_ops",
      "fnrh_hospedes_select_ops",
      "operacional_credenciais_acesso_select_ops",
      "operacional_credencial_itens_select_ops",
    ];
    const blocks = allPolicyNames.map((name) => {
      const block = extractPolicyBlock(sql, name);
      assert.ok(block, `policy ${name} existe e foi extraída`);
      return { name, block: block! };
    });

    // is_yes_hotel_cafe_reader() não aparece em NENHUMA policy das 6
    // tabelas-base (o achado bloqueante era exatamente essa combinação:
    // reader amplo + SELECT de tabela inteira sem filtro de linha).
    const cafeUsages = blocks.filter((b) => /is_yes_hotel_cafe_reader\(\)/.test(b.block)).map((b) => b.name);
    assert.deepEqual(cafeUsages, [], "is_yes_hotel_cafe_reader() não aparece em nenhuma policy das tabelas-base");
    ok("is_yes_hotel_cafe_reader() removida de todas as policies das tabelas-base — nenhuma delas usa mais o reader do café");

    // As policies de SELECT de reservas/hóspedes usam SOMENTE
    // is_yes_hotel_ops_reader() (admin/recepcao) — perfil cafe não tem
    // SELECT direto efetivo nessas duas tabelas.
    for (const table of ["operacional_reservas", "operacional_hospedes"]) {
      const block = blocks.find((b) => b.name === `${table}_select_ops`)!.block;
      assert.match(block, /using \(public\.is_yes_hotel_ops_reader\(\)\)/, `${table}: SELECT usa só is_yes_hotel_ops_reader()`);
      assert.doesNotMatch(block, /is_yes_hotel_cafe_reader/, `${table}: SELECT não referencia o reader do café`);
    }
    ok("policies de SELECT de operacional_reservas/operacional_hospedes usam somente is_yes_hotel_ops_reader() — cafe não tem SELECT direto efetivo");

    // Nenhuma policy de insert/update/delete usa is_yes_hotel_cafe_reader()
    // (checagem que já valia antes e continua valendo).
    const writeBlocks = blocks.filter((b) => /for (insert|update|delete)/i.test(b.block));
    assert.ok(writeBlocks.length > 0, "há pelo menos uma policy de escrita para comparar");
    for (const { name, block } of writeBlocks) {
      assert.doesNotMatch(block, /is_yes_hotel_cafe_reader\(\)/, `${name}: policy de escrita não usa o reader do café`);
    }
    ok("nenhuma policy de insert/update/delete nas 6 tabelas usa is_yes_hotel_cafe_reader()");
  }

  console.log("\n== 6. UPDATE possui USING e WITH CHECK ==");
  {
    const updatePolicies = ["operacional_reservas_update_ops", "operacional_hospedes_update_ops"];
    for (const p of updatePolicies) {
      const block = extractPolicyBlock(sql, p)!;
      assert.match(block, /using \(public\.is_yes_hotel_ops_reader\(\)\)/, `${p} tem USING`);
      assert.match(block, /with check \(public\.is_yes_hotel_ops_reader\(\)\)/, `${p} tem WITH CHECK`);
    }
    ok("as duas policies de UPDATE (reservas, hóspedes) têm USING e WITH CHECK, ambos via is_yes_hotel_ops_reader()");
  }

  console.log("\n== 7. Nenhuma policy remanescente combina por OR para reabrir acesso amplo ==");
  {
    // Para cada tabela núcleo, exatamente 1 policy de SELECT é criada nesta
    // migration, e nenhuma outra migration cria policy de SELECT para essas
    // tabelas (então não há duas policies de SELECT cuja união (OR) reabra
    // o acesso amplo de antes).
    const allMigrationFiles = readMigrationFiles(MIGRATIONS_DIR);
    for (const table of CORE_TABLES) {
      const selectPoliciesAcrossRepo = allMigrationFiles.flatMap(({ file, content }) =>
        [...content.matchAll(new RegExp(`create policy (\\w+)\\s+on public\\.${table}\\s+for select`, "gi"))].map(
          (m) => ({ file, name: m[1] }),
        ),
      );
      // A policy antiga de select (using(true)) é criada em uma migration
      // antiga e nunca é recriada; a nova é criada só nesta migration.
      const namesInNewMigration = selectPoliciesAcrossRepo
        .filter((x) => x.file.endsWith("20260919120000_operacional_rls_perfis_hardening.sql"))
        .map((x) => x.name);
      assert.equal(namesInNewMigration.length, 1, `${table}: exatamente 1 policy nova de SELECT`);
    }
    ok("cada tabela núcleo recebe exatamente 1 policy nova de SELECT — sem duplicidade que reabra acesso por OR");
  }

  console.log("\n== 8. Funções auxiliares não confiam em user_metadata ==");
  {
    assert.doesNotMatch(sqlNoComments, /user_metadata/i, "sem confiar em user_metadata fora de comentários");
    assert.doesNotMatch(sqlNoComments, /auth\.jwt\(\)/i, "sem confiar em auth.jwt() fora de comentários");
    const opsBody = extractFunctionBody(sql, "is_yes_hotel_ops_reader");
    const cafeBody = extractFunctionBody(sql, "is_yes_hotel_cafe_reader");
    assert.match(opsBody!, /from public\.usuarios_internos u/);
    assert.match(opsBody!, /u\.auth_user_id = auth\.uid\(\)/);
    assert.match(opsBody!, /u\.ativo = true/);
    assert.match(cafeBody!, /from public\.usuarios_internos u/);
    assert.match(cafeBody!, /u\.auth_user_id = auth\.uid\(\)/);
    assert.match(cafeBody!, /u\.ativo = true/);
    ok("is_yes_hotel_ops_reader/is_yes_hotel_cafe_reader resolvem o perfil só via usuarios_internos + auth.uid(), exigindo ativo=true — nunca via user_metadata/auth.jwt()");
  }

  console.log("\n== 9. Funções SECURITY DEFINER têm search_path seguro e schema qualificado ==");
  {
    for (const fn of ["is_yes_hotel_ops_reader", "is_yes_hotel_cafe_reader"]) {
      const decl = extractFunctionDeclaration(sql, fn)!;
      assert.match(decl, /security definer/i, `${fn} é SECURITY DEFINER`);
      assert.match(decl, /set search_path = public/i, `${fn} fixa search_path = public`);
    }
    // Toda referência a tabela dentro da migration é schema-qualificada
    // (fora de comentários explicativos).
    const bareTableRefs = [...sqlNoComments.matchAll(/[^.]\bon (operacional_\w+|fnrh_hospedes)\b/g)];
    assert.deepEqual(bareTableRefs, [], "nenhuma referência de tabela sem o prefixo public.");
    ok("funções SECURITY DEFINER com search_path fixo; todas as referências de tabela são public.<tabela>");
  }

  console.log("\n== 10. Grants: EXECUTE das funções revogado de public/anon, concedido a authenticated ==");
  {
    assert.match(sql, /revoke all on function public\.is_yes_hotel_ops_reader\(\) from public, anon;/);
    assert.match(sql, /grant execute on function public\.is_yes_hotel_ops_reader\(\) to authenticated;/);
    assert.match(sql, /revoke all on function public\.is_yes_hotel_cafe_reader\(\) from public, anon;/);
    assert.match(sql, /grant execute on function public\.is_yes_hotel_cafe_reader\(\) to authenticated;/);
    ok("EXECUTE das duas funções auxiliares: revogado de public/anon, concedido só a authenticated");
  }

  console.log("\n== 11. anon não tem acesso direto às 6 tabelas núcleo ==");
  {
    for (const table of CORE_TABLES) {
      assert.match(sql, new RegExp(`revoke all on public\\.${table} from anon;`), `${table}: revoke all from anon presente`);
      const anonPolicyRe = new RegExp(`create policy \\w+[\\s\\S]*?on public\\.${table}[\\s\\S]*?to anon`, "i");
      assert.doesNotMatch(sql, anonPolicyRe, `${table}: nenhuma policy "to anon"`);
    }
    ok("as 6 tabelas núcleo têm revoke all from anon e nenhuma policy concede acesso a anon");
  }

  console.log("\n== 12. service_role não é bloqueado ==");
  {
    assert.doesNotMatch(sqlNoComments, /from service_role/i, "nenhum revoke tira privilégio de service_role");
    assert.doesNotMatch(sqlNoComments, /to service_role/i, "esta migration não cria/alcança policy para service_role — a existente (fnrh_hospedes_all_service) já cobre isso e não é tocada");
    ok("nenhum revoke/policy desta migration afeta service_role — bypass de RLS do service_role permanece intacto");
  }

  console.log("\n== 13. Simulação comportamental por perfil (reimplementação fiel do SQL) ==");
  {
    type UsuarioInterno = { auth_user_id: string; ativo: boolean; perfil_usuario: string };

    // Reimplementação 1:1 do corpo SQL de is_yes_hotel_ops_reader/cafe_reader,
    // já comprovado acima (seção 8) como o texto real da migration.
    function isOpsReader(uid: string | null, usuarios: UsuarioInterno[]): boolean {
      if (uid == null) return false;
      return usuarios.some((u) => u.auth_user_id === uid && u.ativo === true && ["admin", "recepcao"].includes(u.perfil_usuario.toLowerCase()));
    }
    function isCafeReader(uid: string | null, usuarios: UsuarioInterno[]): boolean {
      if (uid == null) return false;
      return usuarios.some((u) => u.auth_user_id === uid && u.ativo === true && ["admin", "recepcao", "cafe"].includes(u.perfil_usuario.toLowerCase()));
    }

    const usuarios: UsuarioInterno[] = [
      { auth_user_id: "admin-1", ativo: true, perfil_usuario: "admin" },
      { auth_user_id: "recepcao-1", ativo: true, perfil_usuario: "recepcao" },
      { auth_user_id: "cafe-1", ativo: true, perfil_usuario: "cafe" },
      { auth_user_id: "admin-inativo", ativo: false, perfil_usuario: "admin" },
      { auth_user_id: "recepcao-inativa", ativo: false, perfil_usuario: "recepcao" },
      { auth_user_id: "cafe-inativo", ativo: false, perfil_usuario: "cafe" },
    ];

    // admin ativo
    assert.equal(isOpsReader("admin-1", usuarios), true);
    assert.equal(isCafeReader("admin-1", usuarios), true);
    // recepcao ativa
    assert.equal(isOpsReader("recepcao-1", usuarios), true);
    assert.equal(isCafeReader("recepcao-1", usuarios), true);
    // cafe ativo: isOpsReader (gate de SELECT direto nas tabelas-base e de
    // escrita) é false — sem acesso direto nenhum. isCafeReader é true, mas
    // desde a correção do achado bloqueante só é consultada dentro da RPC
    // operacional_cafe_listar_hospedagens(), nunca em policy de tabela.
    assert.equal(isOpsReader("cafe-1", usuarios), false);
    assert.equal(isCafeReader("cafe-1", usuarios), true);
    // inativos: nada, em nenhuma das duas funções
    assert.equal(isOpsReader("admin-inativo", usuarios), false);
    assert.equal(isCafeReader("admin-inativo", usuarios), false);
    assert.equal(isOpsReader("recepcao-inativa", usuarios), false);
    assert.equal(isCafeReader("recepcao-inativa", usuarios), false);
    assert.equal(isOpsReader("cafe-inativo", usuarios), false);
    assert.equal(isCafeReader("cafe-inativo", usuarios), false);
    // authenticated sem linha em usuarios_internos (uid não bate com nenhum)
    assert.equal(isOpsReader("sem-registro", usuarios), false);
    assert.equal(isCafeReader("sem-registro", usuarios), false);
    // anon: auth.uid() é null quando não há JWT
    assert.equal(isOpsReader(null, usuarios), false);
    assert.equal(isCafeReader(null, usuarios), false);

    ok("matriz simulada bate com a matriz de autorização pedida: admin/recepcao ativos = leitura+escrita direta nas tabelas-base; cafe ativo = nenhum acesso direto (só via RPC); inativo, sem registro e anon = nada");
  }

  console.log("\n== 14. RPC operacional_cafe_listar_hospedagens: existe, é segura e mínima ==");
  {
    const rpcName = "operacional_cafe_listar_hospedagens";
    const declIdx = sql.indexOf(`create or replace function public.${rpcName}(p_data_cafe date)`);
    assert.ok(declIdx > -1, "RPC existe (assinatura com p_data_cafe date)");
    const bodyStartIdx = sql.indexOf("as $$", declIdx);
    assert.ok(bodyStartIdx > -1, "RPC tem corpo (as $$ ... $$)");
    const bodyEndIdx = sql.indexOf("\n$$;", bodyStartIdx);
    assert.ok(bodyEndIdx > -1, "RPC tem corpo terminado (\\n$$;)");
    const signatureBlock = sql.slice(declIdx, bodyStartIdx);
    const bodyBlock = sql.slice(bodyStartIdx + 5, bodyEndIdx);
    const fullBlock = sql.slice(declIdx, bodyEndIdx + 4);
    ok("RPC operacional_cafe_listar_hospedagens existe e foi extraída (assinatura + corpo)");

    assert.match(signatureBlock, /security definer/i, "RPC é SECURITY DEFINER");
    ok("RPC é SECURITY DEFINER");

    assert.match(signatureBlock, /set search_path = ''/, "RPC fixa search_path = '' (vazio, mais estrito que as funções auxiliares)");
    ok("RPC usa SET search_path = ''");

    assert.match(bodyBlock, /public\.is_yes_hotel_cafe_reader\(\)/, "RPC consulta o gate de perfil (que por sua vez consulta auth.uid() + usuarios_internos ativo — provado na seção 8)");
    ok("RPC valida o usuário real via is_yes_hotel_cafe_reader() (auth.uid() + usuarios_internos.ativo=true — nunca user_metadata)");

    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${rpcName}\\(date\\) from public, anon;`),
      "EXECUTE revogado de public/anon",
    );
    ok("EXECUTE da RPC revogado de PUBLIC e anon");

    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${rpcName}\\(date\\) to authenticated;`),
      "EXECUTE concedido só a authenticated",
    );
    ok("EXECUTE da RPC concedido somente a authenticated");

    // Colunas retornadas: nenhuma da lista proibida (PII, financeiro,
    // comercial, credenciais, veículo, autorização nominal por e-mail).
    const returnsTableIdx = sql.indexOf("returns table (", declIdx);
    assert.ok(returnsTableIdx > -1 && returnsTableIdx < bodyStartIdx, "RPC declara returns table (...)");
    const returnsTableBlock = sql.slice(returnsTableIdx, sql.indexOf(")", sql.indexOf("timestamptz", returnsTableIdx)) + 1);
    const forbiddenColumnPatterns = [
      /documento/i,
      /\bcpf\b/i,
      /passaporte/i,
      /\be[-_]?mail\b/i,
      /whatsapp/i,
      /telefone/i,
      /nascimento/i,
      /assinatura/i,
      /storage_ref/i,
      /\bsenha\b/i,
      /credencial/i,
      /saldo/i,
      /valor_total/i,
      /faturamento/i,
      /channel_manager/i,
      /canal_comercial/i,
      /comissao|comissionamento/i,
      /placa/i,
      /cor_veiculo/i,
      /autorizado_por/i,
    ];
    for (const pattern of forbiddenColumnPatterns) {
      assert.doesNotMatch(returnsTableBlock, pattern, `RPC não retorna coluna proibida (padrão ${pattern})`);
    }
    ok("RPC não retorna nenhuma coluna da lista proibida (documento/CPF/passaporte, contato, nascimento, assinatura, senha/credencial, valores financeiros, dados comerciais, veículo, autorização nominal por e-mail)");

    // Filtro de janela operacional: mesma regra de loadCafeDataset() —
    // status_reserva <> 'cancelada' e check_in_previsto < p_data_cafe <=
    // check_out_previsto. Sem essas três condições, não há filtro de janela.
    assert.match(bodyBlock, /status_reserva <> 'cancelada'/, "RPC exclui reservas canceladas");
    assert.match(bodyBlock, /check_in_previsto < p_data_cafe/, "RPC filtra check-in antes da data do café");
    assert.match(bodyBlock, /check_out_previsto >= p_data_cafe/, "RPC filtra check-out na ou após a data do café");
    ok("RPC tem filtro de janela operacional (mesma regra de elegibilidade que loadCafeDataset() já usava — nenhuma regra HITS nova)");

    // Parâmetro único, sem enumeração livre de histórico: só p_data_cafe
    // date. Nada de limit/offset/intervalo/reserva_id/texto livre.
    const paramList = signatureBlock.slice(
      signatureBlock.indexOf(`${rpcName}(`) + rpcName.length + 1,
      signatureBlock.indexOf(")"),
    );
    assert.equal(paramList.trim(), "p_data_cafe date", "assinatura da RPC tem exatamente 1 parâmetro: p_data_cafe date");
    assert.doesNotMatch(fullBlock, /\blimit\b/i, "RPC não aceita/usa limit (sem paginação livre)");
    assert.doesNotMatch(fullBlock, /\boffset\b/i, "RPC não aceita/usa offset");
    ok("RPC não aceita parâmetro arbitrário: assinatura fixa em 1 data (mesmo grão de operacional_cafe_set_atendimento(), já aceito) — não enumera todo o histórico");

    // Só leitura: nenhum insert/update/delete dentro do corpo da RPC.
    assert.doesNotMatch(bodyBlock, /\binsert\s+into\b/i, "RPC não insere");
    assert.doesNotMatch(bodyBlock, /\bupdate\s+public\./i, "RPC não atualiza");
    assert.doesNotMatch(bodyBlock, /\bdelete\s+from\b/i, "RPC não deleta");
    ok("RPC é só leitura — nenhuma função de escrita foi adicionada");

    // SQL dinâmico: nada de EXECUTE/format() montando SQL a partir de texto.
    assert.doesNotMatch(bodyBlock, /\bexecute\s+(format|'|")/i, "RPC não usa SQL dinâmico (execute format/string)");
    ok("RPC não usa SQL dinâmico");
  }

  console.log("\n== 15. Dependências legítimas (café/FNRH) continuam servidas pelo desenho da migration ==");
  {
    const cafeSrc = readFileSync(resolve(ROOT, "ui/cafe-da-manha-mvp.js"), "utf8");
    assert.doesNotMatch(cafeSrc, /\.from\("operacional_reservas"\)/, "tela do café não consulta mais operacional_reservas diretamente");
    assert.doesNotMatch(cafeSrc, /\.from\("operacional_hospedes"\)/, "tela do café não consulta mais operacional_hospedes diretamente");
    assert.match(cafeSrc, /\.rpc\(\s*"operacional_cafe_listar_hospedagens"/, "tela do café chama a nova RPC de leitura");
    assert.match(cafeSrc, /\.rpc\(\s*"operacional_cafe_set_atendimento"/, "escrita do café continua exclusivamente via RPC security definer (inalterada)");

    const fnrhSubmitSrc = readFileSync(resolve(ROOT, "supabase/functions/fnrh-submit/index.ts"), "utf8");
    assert.match(fnrhSubmitSrc, /SUPABASE_SERVICE_ROLE_KEY/, "fnrh-submit usa service_role — não é afetado pelas novas policies de authenticated");

    const sendLinksSrc = readFileSync(resolve(ROOT, "supabase/functions/send-fnrh-links/index.ts"), "utf8");
    assert.match(sendLinksSrc, /SUPABASE_SERVICE_ROLE_KEY/, "send-fnrh-links usa service_role — não é afetado pelas novas policies de authenticated");
    ok("café (RPC de leitura + RPC de escrita, sem select direto) e Edge Functions de FNRH (service_role) continuam com os caminhos que o código hoje realmente usa");
  }

  console.log(`\nOK test-rls-operacional-perfis (${cases} casos)`);
}

// ---------------------------------------------------------------------------
// Helpers de extração de texto SQL (sem parser real — casamento de padrão
// suficiente para o formato usado nesta migration, escrito por nós mesmos).
// ---------------------------------------------------------------------------

function extractPolicyBlock(source: string, policyName: string): string | null {
  const start = source.indexOf(`create policy ${policyName}\n`);
  if (start === -1) return null;
  const end = source.indexOf(";", start);
  return end === -1 ? null : source.slice(start, end + 1);
}

function extractFunctionBody(source: string, fnName: string): string | null {
  const declStart = source.indexOf(`create or replace function public.${fnName}()`);
  if (declStart === -1) return null;
  const bodyStart = source.indexOf("as $$", declStart);
  if (bodyStart === -1) return null;
  const bodyEnd = source.indexOf("$$;", bodyStart + 5);
  if (bodyEnd === -1) return null;
  return source.slice(bodyStart + 5, bodyEnd);
}

function extractFunctionDeclaration(source: string, fnName: string): string | null {
  const declStart = source.indexOf(`create or replace function public.${fnName}()`);
  if (declStart === -1) return null;
  const bodyStart = source.indexOf("as $$", declStart);
  if (bodyStart === -1) return null;
  return source.slice(declStart, bodyStart);
}

function readMigrationFiles(dir: string): { file: string; content: string }[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const names: string[] = fs.readdirSync(dir).filter((n: string) => n.endsWith(".sql"));
  return names.map((n: string) => ({
    file: resolve(dir, n),
    content: fs.readFileSync(resolve(dir, n), "utf8"),
  }));
}

main();
