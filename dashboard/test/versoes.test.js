// Garante que as imagens Docker continuam com versão fixa (sem ":latest" nem tag vaga como "pg17").
// Uma versão que muda sozinha faz o sistema mudar num restart, sem ninguém ter decidido.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
// "1.2.3", com sufixo opcional ("-pg17", "-debian", "-alpine")
const VERSAO_FIXA = /^\d+\.\d+\.\d+(-[a-z0-9.]+)*$/;

test('docker-compose.yml: toda imagem tem versão fixa (também no valor padrão das variáveis)', () => {
  const compose = fs.readFileSync(path.join(RAIZ, 'docker-compose.yml'), 'utf8');
  const imagens = [...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(imagens.length >= 4, 'esperava encontrar as imagens do postgres, n8n, ngrok e ollama');
  for (const imagem of imagens) {
    const variavel = /:\$\{[A-Z0-9_]+:-([^}]+)\}$/.exec(imagem);
    const tag = variavel ? variavel[1] : imagem.split(':').pop();
    assert.match(tag, VERSAO_FIXA, `imagem sem versão fixa: ${imagem}`);
  }
});

test('Dockerfile do dashboard: imagem do Node com versão fixa', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  const arg = /^ARG NODE_IMAGE=node:(\S+)$/m.exec(dockerfile);
  assert.ok(arg, 'o Dockerfile deveria definir ARG NODE_IMAGE=node:<versão>');
  assert.match(arg[1], VERSAO_FIXA);
  for (const linha of dockerfile.split('\n').filter((l) => l.startsWith('FROM '))) {
    assert.match(linha, /^FROM \$\{NODE_IMAGE\}/, `toda etapa deveria usar o ARG NODE_IMAGE: ${linha}`);
  }
});

test('dependências do dashboard instaladas pelo package-lock.json (npm ci)', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'package-lock.json')), 'falta o package-lock.json');
  assert.doesNotMatch(dockerfile, /npm install/, 'use "npm ci" no Dockerfile (respeita o lockfile)');
});
