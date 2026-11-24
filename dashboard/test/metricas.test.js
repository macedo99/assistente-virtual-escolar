// Funções puras das métricas (src/metricas.js). O cálculo completo, com o banco, é conferido pelo
// scripts/verificar-metricas.js (que roda no CI contra um Postgres de teste).
const { test } = require('node:test');
const assert = require('node:assert');
const m = require('../src/metricas');

test('normalizarPergunta junta variações da mesma pergunta', () => {
  for (const variacao of ['Qual o prazo?', 'qual o prazo', '  Qual   o prazo ?? ', 'QUAL O PRAZO!']) {
    assert.strictEqual(m.normalizarPergunta(variacao), 'qual o prazo');
  }
  assert.notStrictEqual(m.normalizarPergunta('Qual o prazo?'), m.normalizarPergunta('Até quando posso entregar?'), 'sinônimos ainda não são agrupados (etapa 5)');
});

test('datas: validação, soma de dias e lista de dias do período', () => {
  assert.ok(m.dataValida('2026-02-28'));
  for (const ruim of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', '', null]) assert.ok(!m.dataValida(ruim), `deveria recusar ${ruim}`);
  assert.strictEqual(m.somarDias('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(m.somarDias('2026-03-01', -1), '2026-02-28');
  assert.deepStrictEqual(m.diasDoPeriodo('2026-11-29', '2026-12-02'), ['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  assert.strictEqual(m.dataBR('2026-11-18'), '18/11/2026');
});

test('diaLocal usa o fuso de São Paulo (UTC-3)', () => {
  assert.strictEqual(m.diaLocal(new Date('2026-11-24T02:30:00Z')), '2026-11-23', '23h30 em São Paulo ainda é o dia anterior');
  assert.strictEqual(m.diaLocal(new Date('2026-11-24T03:00:00Z')), '2026-11-24');
  assert.strictEqual(m.diaLocal('lixo'), null);
});

test('lerPeriodo: padrão de 30 dias, e recusa período inválido avisando', () => {
  const agora = new Date('2026-11-24T15:00:00Z');
  assert.deepStrictEqual(m.lerPeriodo({}, agora), { de: '2026-10-26', ate: '2026-11-24', aviso: '', invalido: false, motivo: '' });
  assert.strictEqual(m.lerPeriodo({ de: '2026-11-01', ate: '2026-11-10' }, agora).invalido, false);

  const trocado = m.lerPeriodo({ de: '2026-11-10', ate: '2026-11-01' }, agora);
  assert.strictEqual(trocado.invalido, true);
  assert.match(trocado.aviso, /Mostrando os últimos 30 dias/);
  assert.strictEqual(trocado.de, '2026-10-26', 'cai no padrão');

  assert.strictEqual(m.lerPeriodo({ de: 'lixo', ate: '2026-11-01' }, agora).invalido, true);
  assert.strictEqual(m.lerPeriodo({ de: '2026-01-01', ate: '2026-12-31' }, agora).invalido, true, `mais de ${m.DIAS_MAXIMOS} dias`);
});

test('instantes do período: da meia-noite do primeiro dia à meia-noite depois do último (horário de SP)', () => {
  const { ini, fim } = m.instantes({ de: '2026-11-01', ate: '2026-11-01' });
  assert.strictEqual(ini.toISOString(), '2026-11-01T03:00:00.000Z');
  assert.strictEqual(fim.toISOString(), '2026-11-02T03:00:00.000Z');
});

test('percentil interpola como o percentile_cont do Postgres', () => {
  assert.strictEqual(m.percentil([], 0.5), null);
  assert.strictEqual(m.percentil([5], 0.9), 5);
  assert.strictEqual(m.percentil([4, 1, 3, 2], 0.5), 2.5);
  assert.strictEqual(m.percentil([10, 20, 30, 40, 50], 0.9), 46);
});

test('parearEventos: pedido atendido, abandonado e na fila; duração do atendimento', () => {
  const t = (min) => new Date(Date.UTC(2026, 10, 24, 12, min)).toISOString();
  const eventos = [
    { conversa_id: 1, status_novo: 'bot', criado_em: t(0) },
    { conversa_id: 1, status_novo: 'aguardando_atendente', criado_em: t(1) },
    { conversa_id: 1, status_novo: 'atendimento_humano', criado_em: t(4) },
    { conversa_id: 1, status_novo: 'encerrada', criado_em: t(14) },
    { conversa_id: 2, status_novo: 'aguardando_atendente', criado_em: t(2) },
    { conversa_id: 2, status_novo: 'bot', criado_em: t(3) },
    { conversa_id: 3, status_novo: 'aguardando_atendente', criado_em: t(5) },
  ];
  const { pedidos, atendimentos } = m.parearEventos(eventos);
  assert.deepStrictEqual(pedidos.map((p) => [p.conversa_id, p.desfecho, p.espera_s]), [['1', 'atendido', 180], ['2', 'abandonado', null], ['3', 'na_fila', null]]);
  assert.deepStrictEqual(atendimentos.map((a) => [a.conversa_id, a.duracao_s, a.em_andamento]), [['1', 600, false]]);
});

test('formatação pt-BR de duração, percentual e número', () => {
  assert.strictEqual(m.formatarDuracao(null), '—');
  assert.strictEqual(m.formatarDuracao(3.25), '3,3 s');
  assert.strictEqual(m.formatarDuracao(45), '45 s');
  assert.strictEqual(m.formatarDuracao(125), '2 min 05 s');
  assert.strictEqual(m.formatarDuracao(3 * 3600 + 7 * 60), '3 h 07 min');
  assert.strictEqual(m.formatarPercentual(66.666), '66,7%');
  assert.strictEqual(m.formatarPercentual(null), '—');
  assert.strictEqual(m.formatarNumero(12345), '12.345');
});

test('CSV: separador, aspas, quebras de linha e proteção contra injeção de fórmula', () => {
  assert.strictEqual(m.celulaCsv('texto simples'), 'texto simples');
  assert.strictEqual(m.celulaCsv('a;b'), '"a;b"');
  assert.strictEqual(m.celulaCsv('diz "oi"'), '"diz ""oi"""');
  assert.strictEqual(m.celulaCsv('linha1\r\nlinha2'), '"linha1\nlinha2"');
  for (const perigoso of ['=HYPERLINK("http://x")', '+1', '-1+2', '@SOMA(A1)', '\tx']) {
    assert.ok(m.celulaCsv(perigoso).replace(/^"/, '').startsWith("'"), `deveria neutralizar ${JSON.stringify(perigoso)}`);
  }
  assert.strictEqual(m.celulaCsv(2.456), '2,46');
  assert.strictEqual(m.celulaCsv(null), '');
  assert.strictEqual(m.montarCsv([['a', 1], ['b', 2]]), '﻿a;1\r\nb;2\r\n');
});

test('gráfico SVG: barras para os dias e aviso quando não há dados', () => {
  const serie = [{ dia: '2026-11-01', conversas: 2 }, { dia: '2026-11-02', conversas: 0 }];
  const svg = m.graficoBarras(serie, 'conversas', 'Conversas');
  assert.match(svg, /^<svg class="grafico"/);
  assert.strictEqual((svg.match(/class="grafico-barra"/g) || []).length >= 1, true);
  assert.match(m.graficoBarras([{ dia: '2026-11-01', conversas: 0 }], 'conversas', 'x'), /Sem dados no período/);
});

test('calcular: avisos de prompt injection são contados à parte e não entram na satisfação', () => {
  const t = (min) => new Date(Date.UTC(2026, 10, 10, 13, min)).toISOString();
  const msg = (id, remetente, tipo, extra = {}) => ({ id, conversa_id: 1, remetente, tipo, feedback: null, enviada_em: t(id), pergunta_em: remetente === 'bot' ? t(id - 1) : null, ...extra });
  const dados = {
    mensagens: [
      msg(1, 'usuario', null), msg(2, 'bot', 'resposta', { feedback: 'positivo' }),
      msg(3, 'usuario', null), msg(4, 'bot', 'injecao'),
      msg(5, 'usuario', null), msg(6, 'bot', 'injecao'),
    ],
    eventos: [],
    conversas: [{ id: 1, usuario_id: 1 }],
    fila: [],
    novos: {},
  };
  const r = m.calcular(dados, { de: '2026-11-10', ate: '2026-11-10' }, new Date('2026-11-11T12:00:00Z'));
  assert.strictEqual(r.volume.injecoes_bloqueadas, 2);
  assert.strictEqual(r.volume.respostas_bot, 3);
  assert.strictEqual(r.satisfacao.respostas_avaliaveis, 1, 'o aviso de injeção não é uma resposta do modelo');
  assert.match(m.csvResumo(r, 'agora'), /Tentativas de prompt injection bloqueadas;2;mensagens/);
});
