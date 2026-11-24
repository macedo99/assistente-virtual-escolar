// Workflows do n8n versionados em n8n/workflows/: nenhum pode levar segredo escrito direto num nó.
// (O exportar-workflows.sh já avisa; este teste impede o commit passar no CI se o aviso for ignorado.)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { procurarSegredos } = require('../../n8n/limpar-workflows');

const PASTA = path.join(__dirname, '..', '..', 'n8n', 'workflows');

test('a busca de segredos acha tokens escritos nos nós e ignora referências a credenciais', () => {
  const no = (parameters) => ({ nodes: [{ name: 'Nó', parameters }] });
  assert.deepStrictEqual(procurarSegredos(no({ url: 'https://api.telegram.org/bot1234567890:AAEhBP0av18uU3ZxyzZxyzZxyzZxyzZxyz1/sendMessage' })).map((a) => a.tipo), ['token de bot do Telegram']);
  assert.strictEqual(procurarSegredos(no({ headerValue: 'Bearer abcdefghijklmnopqrstuvwxyz0123' })).length, 1);
  assert.strictEqual(procurarSegredos(no({ password: 'senha-de-verdade' })).length, 1);
  assert.strictEqual(procurarSegredos(no({ url: 'postgres://admin:segredo@postgres:5432/chatbot' })).length, 1);
  assert.strictEqual(procurarSegredos(no({ token: '={{ $credentials.token }}', url: 'http://ollama:11434/api/embed' })).length, 0);
});

test('nenhum workflow versionado tem segredo escrito direto num nó', (t) => {
  if (!fs.existsSync(PASTA)) return t.skip('n8n/workflows ainda não existe (rode n8n/exportar-workflows.sh)');
  const arquivos = fs.readdirSync(PASTA).filter((nome) => nome.endsWith('.json'));
  for (const arquivo of arquivos) {
    const workflow = JSON.parse(fs.readFileSync(path.join(PASTA, arquivo), 'utf8'));
    const achados = procurarSegredos(workflow);
    assert.deepStrictEqual(achados, [], `${arquivo}: ${achados.map((a) => `nó "${a.no}" (${a.tipo})`).join('; ')} — troque por uma credencial do n8n e exporte de novo`);
    assert.strictEqual(workflow.pinData, undefined, `${arquivo} tem pinData (dados de execução): exporte pelo n8n/exportar-workflows.sh`);
  }
});
