const express = require('express');
const pool = require('../db');
const base = require('../base');
const ingestao = require('../ingestao');
const { exigirCsrf } = require('../csrf');
const { exigirAdmin } = require('../admin');
const { formatarHoraCompleta } = require('../formato');

const router = express.Router();

// Recado que sobrevive a um redirect (mesmo mecanismo da tela de conversas).
function avisar(req, tipo, texto) {
  req.session.aviso = { tipo, texto }; // tipo: 'ok' | 'aviso' | 'erro'
}
function consumirAviso(req) {
  const aviso = req.session.aviso || null;
  delete req.session.aviso;
  return aviso;
}

// Avisa o n8n para indexar o item. Se não conseguir avisar, o item vira "erro" (em vez de ficar "pendente"
// pra sempre): assim o botão Reindexar aparece e o motivo vai para a tela.
async function iniciarIndexacao(itemId) {
  try {
    await ingestao.acionar(itemId);
    return { acionada: true };
  } catch (err) {
    console.error(`Indexação do item ${itemId} não acionada: ${err.codigo || err.name} ${err.detalhe || ''}`);
    try {
      await base.marcarErro(pool, itemId);
    } catch (erroBanco) {
      console.error('Também não consegui marcar o item como "erro":', erroBanco.message);
    }
    return { acionada: false, motivo: err.message };
  }
}

// Tudo que a tela do formulário precisa, com valores padrão (o EJS dá erro se faltar alguma variável).
function dadosDoFormulario(req, extras) {
  return {
    modo: 'novo',
    id: null,
    valores: { titulo: '', conteudo: '' },
    erros: {},
    erroGeral: '',
    situacao: null,
    limites: { titulo: base.TITULO_MAXIMO, conteudo: base.CONTEUDO_MAXIMO },
    atendente: req.session.atendente,
    aviso: consumirAviso(req),
    ...extras,
  };
}

// Lista de itens + estado da indexação de cada um
router.get('/base', exigirAdmin, async (req, res, next) => {
  try {
    const agora = new Date();
    const itens = (await base.listar(pool)).map((item) => base.apresentar(item, agora));
    res.render('base', {
      itens,
      contagem: base.contar(itens),
      atualizadaEm: formatarHoraCompleta(agora),
      atendente: req.session.atendente,
      aviso: consumirAviso(req),
    });
  } catch (err) {
    next(err);
  }
});

// Usado pelo polling da lista (a cada 4 s): estado atual de cada item, para a tela ver
// "Indexando…" virar "Indexado" sem recarregar.
router.get('/api/base/status', exigirAdmin, async (req, res, next) => {
  try {
    const agora = new Date();
    const itens = (await base.listar(pool)).map((item) => base.apresentar(item, agora));
    res.json({ ok: true, itens, contagem: base.contar(itens), atualizada_em: formatarHoraCompleta(agora) });
  } catch (err) {
    next(err);
  }
});

// ?titulo=... pré-preenche o título (o link "Cadastrar na base" da tela de Métricas usa isso: a pergunta sem
// resposta vira o título do novo item, e quem cadastra só escreve a resposta).
router.get('/base/novo', exigirAdmin, (req, res) => {
  const pedido = (req.query || {}).titulo;
  const titulo = typeof pedido === 'string' ? pedido.replace(/\s+/g, ' ').trim().slice(0, base.TITULO_MAXIMO) : '';
  res.render('base-form', dadosDoFormulario(req, { modo: 'novo', valores: { titulo, conteudo: '' } }));
});

router.post('/base', exigirAdmin, exigirCsrf, async (req, res, next) => {
  try {
    const v = base.validarItem(req.body);
    if (!v.ok) {
      return res.status(400).render('base-form', dadosDoFormulario(req, { modo: 'novo', valores: v.valores, erros: v.erros }));
    }

    const id = await base.criar(pool, v.valores);
    const inicio = await iniciarIndexacao(id);
    if (inicio.acionada) {
      avisar(req, 'ok', `Item “${v.valores.titulo}” salvo. A indexação começou: o status muda sozinho para Indexado.`);
    } else {
      avisar(req, 'aviso', `Item “${v.valores.titulo}” salvo, mas não consegui iniciar a indexação: ${inicio.motivo} Corrija e use Reindexar.`);
    }
    res.redirect('/base');
  } catch (err) {
    next(err);
  }
});

router.get('/base/:id/editar', exigirAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!base.idValido(id)) return res.status(404).send('Item não encontrado.');

    const item = await base.obter(pool, id);
    if (!item) return res.status(404).send('Item não encontrado.');

    res.render('base-form', dadosDoFormulario(req, {
      modo: 'editar',
      id: String(item.id),
      valores: { titulo: item.titulo, conteudo: base.normalizarTexto(item.conteudo) },
      situacao: base.apresentar(item),
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/base/:id', exigirAdmin, exigirCsrf, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!base.idValido(id)) return res.status(404).send('Item não encontrado.');

    const v = base.validarItem(req.body);
    const item = await base.obter(pool, id);
    if (!item) {
      avisar(req, 'erro', 'Item não encontrado (ele pode ter sido excluído).');
      return res.redirect('/base');
    }
    const situacao = base.apresentar(item);

    if (!v.ok) {
      return res.status(400).render('base-form', dadosDoFormulario(req, { modo: 'editar', id: String(id), valores: v.valores, erros: v.erros, situacao }));
    }

    const resultado = await base.atualizar(pool, id, v.valores);
    if (!resultado.ok) {
      if (resultado.http === 404) {
        avisar(req, 'erro', resultado.mensagem);
        return res.redirect('/base');
      }
      // 409 (está sendo indexado agora): volta ao formulário sem perder o que foi digitado
      return res.status(409).render('base-form', dadosDoFormulario(req, { modo: 'editar', id: String(id), valores: v.valores, situacao, erroGeral: resultado.mensagem }));
    }

    if (!resultado.reindexar) {
      avisar(req, 'ok', `Item “${v.valores.titulo}” atualizado. O conteúdo não mudou, então não foi preciso reindexar.`);
      return res.redirect('/base');
    }

    const inicio = await iniciarIndexacao(id);
    if (inicio.acionada) {
      avisar(req, 'ok', `Item “${v.valores.titulo}” atualizado. O conteúdo mudou, então ele está sendo reindexado (fica fora das respostas do bot até terminar).`);
    } else {
      avisar(req, 'aviso', `Item “${v.valores.titulo}” atualizado, mas não consegui iniciar a reindexação: ${inicio.motivo} Corrija e use Reindexar.`);
    }
    res.redirect('/base');
  } catch (err) {
    next(err);
  }
});

router.post('/base/:id/reindexar', exigirAdmin, exigirCsrf, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!base.idValido(id)) return res.status(404).send('Item não encontrado.');

    const marcado = await base.marcarParaReindexar(pool, id);
    if (!marcado.ok) {
      avisar(req, marcado.http === 404 ? 'erro' : 'aviso', marcado.mensagem);
      return res.redirect('/base');
    }

    const inicio = await iniciarIndexacao(id);
    if (inicio.acionada) avisar(req, 'ok', 'Reindexação iniciada: o status muda sozinho para Indexado.');
    else avisar(req, 'aviso', `Não consegui iniciar a reindexação: ${inicio.motivo}`);
    res.redirect('/base');
  } catch (err) {
    next(err);
  }
});

router.post('/base/:id/excluir', exigirAdmin, exigirCsrf, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!base.idValido(id)) return res.status(404).send('Item não encontrado.');

    const titulo = await base.excluir(pool, id);
    if (titulo === null) avisar(req, 'erro', 'Item não encontrado (ele pode ter sido excluído).');
    else avisar(req, 'ok', `Item “${titulo}” excluído. O bot deixou de usar esse conteúdo.`);
    res.redirect('/base');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
