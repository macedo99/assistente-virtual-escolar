// Regras do atendimento humano (src/atendimento.js): quem pode fazer o quê em cada estado da conversa.
const { test } = require('node:test');
const assert = require('node:assert');
const { permissoes, mesmoId, textoDoAtendente } = require('../src/atendimento');

const ana = { id: 1, papel: 'atendente' };
const beto = { id: 2, papel: 'atendente' };
const admin = { id: 9, papel: 'admin' };

test('mesmoId compara ids de tipos diferentes (número x texto) e nunca casa nulos', () => {
  assert.ok(mesmoId(1, '1'));
  assert.ok(!mesmoId(1, 2));
  assert.ok(!mesmoId(null, null));
  assert.ok(!mesmoId(undefined, 1));
});

test('conversa só com o bot ou na fila: qualquer atendente pode assumir; ninguém responde', () => {
  for (const status of ['bot', 'aguardando_atendente']) {
    assert.deepStrictEqual(permissoes({ status, atendente_id: null }, ana), { assumir: true, responder: false, devolver: false, encerrar: false });
  }
});

test('em atendimento humano: só o responsável (ou um admin) responde, devolve e encerra', () => {
  const conversa = { status: 'atendimento_humano', atendente_id: 1 };
  assert.deepStrictEqual(permissoes(conversa, ana), { assumir: false, responder: true, devolver: true, encerrar: true });
  assert.deepStrictEqual(permissoes(conversa, beto), { assumir: false, responder: false, devolver: false, encerrar: false });
  assert.deepStrictEqual(permissoes(conversa, admin), { assumir: false, responder: true, devolver: true, encerrar: true });
});

test('em atendimento humano sem responsável: pode assumir, devolver ou encerrar, mas não responder', () => {
  assert.deepStrictEqual(permissoes({ status: 'atendimento_humano', atendente_id: null }, beto), { assumir: true, responder: false, devolver: true, encerrar: true });
});

test('conversa encerrada: nenhuma ação', () => {
  assert.deepStrictEqual(permissoes({ status: 'encerrada', atendente_id: 1 }, admin), { assumir: false, responder: false, devolver: false, encerrar: false });
});

test('textoDoAtendente identifica quem escreveu', () => {
  assert.strictEqual(textoDoAtendente('Ana', 'Olá!'), '🧑‍💼 Ana: Olá!');
});
