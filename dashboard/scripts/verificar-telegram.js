// Confere se o dashboard consegue falar com o Telegram usando o TELEGRAM_BOT_TOKEN do .env.
// Rode DENTRO do container do dashboard:
//
//   docker compose exec dashboard node scripts/verificar-telegram.js
//
// Por padrão NÃO envia nada pra ninguém: só pergunta ao Telegram de quem é o token.
// Para testar o envio de verdade, passe o seu chat id (o número em usuarios.telegram_chat_id):
//
//   docker compose exec dashboard node scripts/verificar-telegram.js 123456789
const telegram = require('../src/telegram');

const DICAS = {
  config: 'Coloque TELEGRAM_BOT_TOKEN=... no .env (na pasta do docker-compose.yml) e recrie o container: docker compose up -d dashboard',
  token: 'Copie o token de novo no BotFather (/mybots → seu bot → API Token), sem aspas e sem espaços, e recrie o container: docker compose up -d dashboard',
  rede: 'O container não alcançou api.telegram.org. Teste a internet do Docker e o DNS; veja a seção "Solução de problemas" do guia.',
  timeout: 'O Telegram não respondeu a tempo. Tente de novo; se persistir, veja a seção "Solução de problemas" do guia.',
  bloqueado: 'Esse chat bloqueou o bot. Mande /start para o bot por esse chat e tente de novo.',
  chat_inexistente: 'Esse chat id não existe para este bot. Confira o número em usuarios.telegram_chat_id.',
};

async function main() {
  const chatId = process.argv[2];

  const bot = await telegram.obterBot();
  console.log(`  ✔  O Telegram reconheceu o token. Bot: @${bot.username} (${bot.first_name})`);

  if (chatId) {
    await telegram.enviarMensagem(chatId, '✅ Teste do dashboard: se você está lendo isto, o envio de mensagens pelo bot está funcionando.');
    console.log(`  ✔  Mensagem de teste enviada para o chat ${chatId}. Confira no Telegram.`);
  } else {
    console.log('  –  Envio não testado (dica: passe o seu chat id como argumento para mandar uma mensagem de teste).');
  }

  console.log('\nTudo certo: o dashboard consegue falar com o Telegram.');
}

main().catch((err) => {
  console.error(`  ✘  ${err.message}`);
  if (DICAS[err.codigo]) console.error(`         → ${DICAS[err.codigo]}`);
  process.exit(1);
});
