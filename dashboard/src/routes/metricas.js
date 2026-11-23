const express = require('express');
const pool = require('../db');
const metricas = require('../metricas');
const { exigirAdmin } = require('../admin');
const { formatarDataHora, formatarHora } = require('../formato');

const router = express.Router();

const TIPOS_CSV = ['resumo', 'conversas', 'lacunas'];
const LINHAS_LACUNAS_NA_TELA = 50; // o CSV traz todas

// "18/11/2026 21:05" — com o ano, para o CSV e para o cabeçalho da impressão
const dataHoraCompleta = (data) => `${metricas.dataBR(metricas.diaLocal(data))} ${formatarHora(data)}`;

// Tela de métricas. Período: ?de=AAAA-MM-DD&ate=AAAA-MM-DD (padrão: últimos 30 dias).
router.get('/metricas', exigirAdmin, async (req, res, next) => {
  try {
    const agora = new Date();
    const { de, ate, aviso } = metricas.lerPeriodo(req.query, agora);
    const periodo = { de, ate };
    const r = metricas.calcular(await metricas.coletar(pool, periodo), periodo, agora);

    res.render('metricas', {
      r,
      periodo,
      atalhos: metricas.atalhos(agora),
      aviso: aviso ? { tipo: 'aviso', texto: aviso } : null,
      atendente: req.session.atendente,
      geradoEm: dataHoraCompleta(agora),
      motivos: metricas.MOTIVOS,
      lacunasNaTela: r.lacunas.slice(0, LINHAS_LACUNAS_NA_TELA),
      graficoConversas: metricas.graficoBarras(r.serie, 'conversas', 'Conversas ativas por dia'),
      graficoMensagens: metricas.graficoBarras(r.serie, 'mensagens', 'Mensagens do usuário por dia'),
      fmt: {
        duracao: metricas.formatarDuracao,
        pct: metricas.formatarPercentual,
        num: metricas.formatarNumero,
        dataBR: metricas.dataBR,
        dataHora: formatarDataHora,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Exportação: /metricas/exportar.csv?tipo=resumo|conversas|lacunas&de=...&ate=...
// (O PDF sai do botão "Imprimir / PDF" da tela, pelo "Salvar como PDF" do navegador.)
router.get('/metricas/exportar.csv', exigirAdmin, async (req, res, next) => {
  try {
    const consulta = req.query || {};
    const tipo = String(consulta.tipo || '');
    if (!TIPOS_CSV.includes(tipo)) return res.status(400).send('Tipo de relatório inválido. Use resumo, conversas ou lacunas.');

    const agora = new Date();
    const lido = metricas.lerPeriodo(consulta, agora);
    // Um relatório com o período trocado em silêncio enganaria quem o recebe: aqui recusamos.
    if (lido.invalido) return res.status(400).send(lido.motivo);

    const periodo = { de: lido.de, ate: lido.ate };
    const r = metricas.calcular(await metricas.coletar(pool, periodo), periodo, agora);
    const corpo = {
      resumo: () => metricas.csvResumo(r, dataHoraCompleta(agora)),
      conversas: () => metricas.csvConversas(r),
      lacunas: () => metricas.csvLacunas(r, dataHoraCompleta),
    }[tipo]();

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="metricas-${tipo}-${periodo.de}_a_${periodo.ate}.csv"`);
    res.send(corpo);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
