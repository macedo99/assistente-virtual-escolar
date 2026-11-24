// Datas e horas no fuso de São Paulo (src/formato.js).
const { test } = require('node:test');
const assert = require('node:assert');
const f = require('../src/formato');

test('formata no horário de São Paulo (UTC-3), não no do servidor', () => {
  const instante = new Date('2026-11-24T02:05:09Z'); // 23:05:09 do dia 23 em São Paulo
  assert.strictEqual(f.formatarDataHora(instante), '23/11 23:05');
  assert.strictEqual(f.formatarHora(instante), '23:05');
  assert.strictEqual(f.formatarHoraCompleta(instante), '23:05:09');
  assert.strictEqual(f.formatarHora('2026-11-24T03:00:00Z'), '00:00', 'meia-noite é 00, nunca 24');
});

test('valores vazios ou inválidos não quebram a tela', () => {
  assert.strictEqual(f.formatarDataHora(null), '—');
  assert.strictEqual(f.formatarDataHora('lixo'), '—');
  assert.strictEqual(f.formatarHora(undefined), '');
  assert.strictEqual(f.tempoDecorrido(null), '');
});

test('tempoDecorrido: minutos, horas e dias; relógio adiantado nunca dá tempo negativo', () => {
  const agora = new Date('2026-11-24T12:00:00Z');
  const antes = (min) => new Date(agora.getTime() - min * 60000);
  assert.strictEqual(f.tempoDecorrido(antes(0.5), agora), 'menos de 1 min');
  assert.strictEqual(f.tempoDecorrido(antes(7), agora), '7 min');
  assert.strictEqual(f.tempoDecorrido(antes(125), agora), '2 h 05 min');
  assert.strictEqual(f.tempoDecorrido(antes(3 * 1440 + 240), agora), '3 d 4 h');
  assert.strictEqual(f.tempoDecorrido(new Date(agora.getTime() + 60000), agora), 'menos de 1 min');
});
