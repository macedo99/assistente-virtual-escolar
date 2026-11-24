// Cenário de teste das métricas (Passo 8c): três usuários, três conversas, mensagens e eventos com HORÁRIOS
// CONTROLADOS, e os números que as métricas precisam dar. É usado pelo verificar-metricas.js, que grava
// o cenário no banco (numa transação desfeita) e confere o resultado.
//
// Tudo acontece em janeiro de 2099 para nunca se misturar com dados reais. Os horários têm o fuso de
// São Paulo (-03:00) escrito de propósito: o teste confere que o dia é contado no fuso certo.
const { AVISOS } = require('../src/atendimento');

const PERIODO = { de: '2099-01-01', ate: '2099-01-31' };

// O mesmo "não encontrei" que o n8n manda (nó "Gravar resposta bot").
const FALLBACK = 'Não encontrei uma resposta confiável para isso na nossa base. Digite /humano se quiser falar com um atendente.';

const USUARIOS = [
  { chave: 'U1', nome: 'Ana (verificar-metricas)', papel: 'professor', criado_em: '2099-01-09T08:00:00-03:00' },
  { chave: 'U2', nome: 'Bruno (verificar-metricas)', papel: 'gestor', criado_em: null },
  { chave: 'U3', nome: 'Carla (verificar-metricas)', papel: 'professor', criado_em: null },
];

// criado_em/iniciada_em nulo = "agora" (fora do período de 2099 de propósito)
const CONVERSAS = [
  { chave: 'C1', usuario: 'U1', iniciada_em: '2099-01-09T08:00:00-03:00' },
  { chave: 'C2', usuario: 'U2', iniciada_em: null },
  { chave: 'C3', usuario: 'U3', iniciada_em: null },
];

// Em ordem cronológica dentro de cada conversa (o id é quem define "a mensagem anterior").
const MENSAGENS = [
  // ---- C1: pergunta respondida (4 s, 👍), pergunta sem resposta (9 s), pedido de atendente e atendimento
  { c: 'C1', de: 'usuario', texto: 'Qual o prazo para lançar as notas?', em: '2099-01-10T09:00:00-03:00' },
  { c: 'C1', de: 'bot', texto: 'O prazo é 20/12. (Fonte: Prazo das notas)', feedback: 'positivo', em: '2099-01-10T09:00:04-03:00' },
  { c: 'C1', de: 'usuario', texto: 'Como emito o holerite?', em: '2099-01-10T09:05:00-03:00' },
  { c: 'C1', de: 'bot', texto: FALLBACK, em: '2099-01-10T09:05:09-03:00' },
  { c: 'C1', de: 'usuario', texto: 'Preciso falar com alguém', em: '2099-01-10T09:06:00-03:00' },
  { c: 'C1', de: 'bot', texto: AVISOS.assumiu('Bruno'), em: '2099-01-10T09:08:31-03:00' }, // aviso: NÃO conta como resposta
  { c: 'C1', de: 'atendente', texto: 'Olá, vou ajudar.', em: '2099-01-10T09:10:00-03:00' },
  { c: 'C1', de: 'bot', texto: AVISOS.devolveu(), em: '2099-01-10T09:20:31-03:00' }, // aviso

  // ---- C2: resposta com 👎 (6 s), "o contexto não contém" (5 s) e o mesmo "como emito o holerite" sem resposta (3 s)
  { c: 'C2', de: 'usuario', texto: 'Qual o horário da secretaria?', em: '2099-01-11T14:00:00-03:00' },
  { c: 'C2', de: 'bot', texto: 'A secretaria funciona de 8h às 17h.', feedback: 'negativo', em: '2099-01-11T14:00:06-03:00' },
  { c: 'C2', de: 'usuario', texto: 'Quem é o diretor?', em: '2099-01-11T14:01:00-03:00' },
  { c: 'C2', de: 'bot', texto: 'O contexto fornecido não contém informações sobre o diretor.', em: '2099-01-11T14:01:05-03:00' },
  { c: 'C2', de: 'usuario', texto: 'como emito o holerite', em: '2099-01-11T14:03:00-03:00' },
  { c: 'C2', de: 'bot', texto: FALLBACK, em: '2099-01-11T14:03:03-03:00' },

  // ---- C3: fronteiras do período (o dia é o de São Paulo) + uma pergunta respondida (2 s, 👍)
  { c: 'C3', de: 'usuario', texto: 'Mensagem do dia anterior ao período', em: '2098-12-31T23:59:59-03:00' }, // FORA
  { c: 'C3', de: 'usuario', texto: 'Mensagem no primeiro segundo do período', em: '2099-01-01T00:00:00-03:00' }, // dentro
  { c: 'C3', de: 'usuario', texto: 'Qual o prazo para lançar as notas?', em: '2099-01-12T10:00:00-03:00' },
  { c: 'C3', de: 'bot', texto: 'O prazo é 20/12. (Fonte: Prazo das notas)', feedback: 'positivo', em: '2099-01-12T10:00:02-03:00' },
  { c: 'C3', de: 'usuario', texto: 'Mensagem no último segundo do período', em: '2099-01-31T23:59:59-03:00' }, // dentro
  { c: 'C3', de: 'usuario', texto: 'Mensagem do dia seguinte ao período', em: '2099-02-01T00:00:00-03:00' }, // FORA
];

// Trilha de status (o gatilho do banco só grava "agora"; aqui os horários são os do cenário)
const EVENTOS = [
  { c: 'C1', de: 'bot', para: 'aguardando_atendente', em: '2099-01-10T09:06:30-03:00' },
  { c: 'C1', de: 'aguardando_atendente', para: 'atendimento_humano', em: '2099-01-10T09:08:30-03:00' }, // espera: 120 s
  { c: 'C1', de: 'atendimento_humano', para: 'bot', em: '2099-01-10T09:20:30-03:00' }, // atendimento: 720 s
];

const ESPERADO = {
  volume: { conversas_ativas: 3, mensagens_usuario: 9, respostas_bot: 6, injecoes_bloqueadas: 0, usuarios_ativos: 3, usuarios_novos: 1, conversas_novas: 1 },
  satisfacao: { positivas: 2, negativas: 1, avaliadas: 3, respostas_avaliaveis: 4, percentual: (2 / 3) * 100, taxa_avaliacao: 75 },
  atendimento: {
    conversas: 3, conversas_com_pedido: 1, pedidos: 1, pedidos_atendidos: 1, pedidos_abandonados: 0, pedidos_na_fila: 0,
    taxa_handoff: (1 / 3) * 100, taxa_resolucao_bot: 100 - (1 / 3) * 100,
  },
  espera: { n: 1, mediana_s: 120, p90_s: 120 },
  duracao: { n: 1, mediana_s: 720, p90_s: 720, em_andamento: 0 },
  // tempos de resposta: 4, 9, 6, 5, 3 e 2 s → ordenados 2,3,4,5,6,9
  resposta_bot: { n: 6, mediana_s: 4.5, p90_s: 7.5, dentro_do_limite_pct: (4 / 6) * 100 },
  // dias com movimento (todos os outros do mês: zero)
  serie: {
    dias: 31,
    movimento: {
      '2099-01-01': { conversas: 1, mensagens: 1 },
      '2099-01-10': { conversas: 1, mensagens: 3 },
      '2099-01-11': { conversas: 1, mensagens: 3 },
      '2099-01-12': { conversas: 1, mensagens: 1 },
      '2099-01-31': { conversas: 1, mensagens: 1 },
    },
  },
  // ordem: mais vezes primeiro; empate: a mais recente primeiro
  lacunas: [
    { pergunta: 'como emito o holerite', vezes: 2, motivos: ['sem_resposta'] },
    { pergunta: 'Quem é o diretor?', vezes: 1, motivos: ['contexto_insuficiente'] },
    { pergunta: 'Qual o horário da secretaria?', vezes: 1, motivos: ['avaliacao_negativa'] },
  ],
  conversas: [
    { usuario: 'Ana (verificar-metricas)', mensagens_usuario: 3, respostas_bot: 2, pedidos: 1, espera_total_s: 120, atendimento_total_s: 720 },
    { usuario: 'Bruno (verificar-metricas)', mensagens_usuario: 3, respostas_bot: 3, pedidos: 0, espera_total_s: null, atendimento_total_s: null },
    { usuario: 'Carla (verificar-metricas)', mensagens_usuario: 3, respostas_bot: 1, pedidos: 0, espera_total_s: null, atendimento_total_s: null },
  ],
};

module.exports = { PERIODO, FALLBACK, USUARIOS, CONVERSAS, MENSAGENS, EVENTOS, ESPERADO };
