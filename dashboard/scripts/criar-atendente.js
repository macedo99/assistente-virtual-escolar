// Cria um atendente (quem faz login no dashboard) direto no banco, já com a senha criptografada.
// Rode DENTRO do container do dashboard (ele já tem as variáveis de conexão com o banco):
//
//   docker compose exec dashboard node scripts/criar-atendente.js "Seu Nome" "seu@email.com" "SuaSenha" admin
//
// O último argumento é o papel: "admin" ou "atendente" (se omitido, "atendente").
// (O cadastro de atendentes continua sendo feito só por este script; não há tela para isso.)
const bcrypt = require('bcryptjs');
const pool = require('../src/db');

const USO = 'Uso: node scripts/criar-atendente.js "Nome" "email@exemplo.com" "Senha" [admin|atendente]';

async function main() {
  const [nome, emailInformado, senha, papelInformado] = process.argv.slice(2);
  const papel = papelInformado || 'atendente';

  if (!nome || !emailInformado || !senha) {
    console.error(USO);
    process.exit(1);
  }
  if (!['admin', 'atendente'].includes(papel)) {
    console.error(`Papel inválido: "${papel}". Use "admin" ou "atendente".`);
    process.exit(1);
  }
  if (senha.length < 8) {
    console.error('A senha precisa ter pelo menos 8 caracteres.');
    process.exit(1);
  }

  // O login compara o e-mail sem diferenciar maiúsculas; guardamos sempre em minúsculas.
  const email = emailInformado.trim().toLowerCase();
  const senhaHash = await bcrypt.hash(senha, 10);

  try {
    const resultado = await pool.query(
      'INSERT INTO atendentes (nome, email, senha_hash, papel) VALUES ($1, $2, $3, $4) RETURNING id',
      [nome.trim(), email, senhaHash, papel]
    );
    console.log(`Atendente criado: id ${resultado.rows[0].id} — ${email} (${papel}).`);
  } catch (err) {
    if (err.code === '23505') {
      // violação de UNIQUE: já existe um atendente com esse e-mail
      console.error(`Já existe um atendente com o e-mail ${email}.`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Falha ao criar o atendente:', err.message);
  process.exit(1);
});
