// Aplica as migrações do banco (arquivos .sql da pasta migracoes/, em ordem alfabética).
// Rode DENTRO do container do dashboard (ele já tem as variáveis de conexão com o banco):
//
//   docker compose exec dashboard node scripts/aplicar-migracao.js
//
// É seguro rodar mais de uma vez: os arquivos só criam o que ainda não existe e nunca apagam dados.
// Cada arquivo é enviado ao Postgres de uma vez só, então vale tudo-ou-nada: se qualquer comando
// falhar, nada daquele arquivo fica aplicado pela metade.
const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

const PASTA = path.join(__dirname, '..', 'migracoes');
// Códigos de "não consegui nem conectar": não é falha do arquivo .sql, e a mensagem é outra (veja o main().catch).
const SEM_CONEXAO = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'];

async function main() {
  const arquivos = fs.readdirSync(PASTA).filter((nome) => nome.endsWith('.sql')).sort();
  if (arquivos.length === 0) {
    console.error(`Nenhum arquivo .sql encontrado em ${PASTA}.`);
    process.exit(1);
  }

  let falhou = false;
  for (const arquivo of arquivos) {
    const sql = fs.readFileSync(path.join(PASTA, arquivo), 'utf8');
    try {
      await pool.query(sql);
      console.log(`  ✔  ${arquivo}`);
    } catch (err) {
      if (SEM_CONEXAO.includes(err.code)) throw err;
      console.error(`  ✘  ${arquivo}\n         → ${err.message}`);
      falhou = true;
      break; // os próximos podem depender deste: melhor parar
    }
  }
  await pool.end();

  if (falhou) {
    console.error('\nA migração NÃO foi aplicada (nada ficou pela metade). Veja a mensagem acima e a seção "Solução de problemas" do guia.');
    process.exit(1);
  }
  console.log('\nBanco atualizado. Para conferir: docker compose exec dashboard node scripts/verificar-banco.js');
}

main().catch(async (err) => {
  console.error(SEM_CONEXAO.includes(err.code)
    ? `Não consegui falar com o banco (${err.code}). O container do Postgres está de pé? Confira com: docker compose ps`
    : `Falha ao aplicar a migração: ${err.message}`);
  try { await pool.end(); } catch (e) { /* já fechado */ }
  process.exit(1);
});
