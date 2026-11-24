// Comportamentos comuns a todas as telas do dashboard.
//
// 1. Confirmação: um <form data-confirmar="Pergunta?"> abre uma caixa de diálogo antes de enviar
//    (data-confirmar-botao muda o texto do botão; data-confirmar-perigo="1" deixa o botão vermelho).
//    Se o navegador não suportar <dialog>, cai no window.confirm.
// 2. Recados (data-recado): o botão × fecha.
// Todo texto vai por textContent: nada vindo da página é interpretado como HTML.

(function () {
  'use strict';

  function criarDialogo() {
    const dialogo = document.createElement('dialog');
    dialogo.className = 'dialogo';
    dialogo.setAttribute('aria-labelledby', 'dialogo-titulo');

    const corpo = document.createElement('div');
    corpo.className = 'p-6';
    const titulo = document.createElement('h2');
    titulo.id = 'dialogo-titulo';
    titulo.className = 'text-base font-semibold text-slate-900';
    titulo.textContent = 'Confirmar';
    const texto = document.createElement('p');
    texto.className = 'mt-2 text-sm leading-relaxed text-slate-600';
    corpo.append(titulo, texto);

    const rodape = document.createElement('div');
    rodape.className = 'flex justify-end gap-2 rounded-b-2xl border-t border-slate-100 bg-slate-50 px-6 py-3';
    const cancelar = document.createElement('button');
    cancelar.type = 'button';
    cancelar.className = 'btn';
    cancelar.textContent = 'Cancelar';
    const confirmar = document.createElement('button');
    confirmar.type = 'button';
    rodape.append(cancelar, confirmar);

    dialogo.append(corpo, rodape);
    document.body.appendChild(dialogo);

    let aoConfirmar = null;
    cancelar.addEventListener('click', () => dialogo.close());
    confirmar.addEventListener('click', () => {
      dialogo.close();
      if (aoConfirmar) aoConfirmar();
    });
    // clique fora da caixa fecha
    dialogo.addEventListener('click', (e) => { if (e.target === dialogo) dialogo.close(); });

    return function abrir({ pergunta, botao, perigo }, callback) {
      texto.textContent = pergunta;
      confirmar.textContent = botao || 'Confirmar';
      confirmar.className = perigo ? 'btn btn-perigo-cheio' : 'btn btn-primario';
      aoConfirmar = callback;
      dialogo.showModal();
      cancelar.focus();
    };
  }

  let abrirDialogo = null;

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.confirmar) return;
    if (form.dataset.confirmado === '1') { delete form.dataset.confirmado; return; }

    e.preventDefault();
    const opcoes = { pergunta: form.dataset.confirmar, botao: form.dataset.confirmarBotao, perigo: form.dataset.confirmarPerigo === '1' };

    if (typeof HTMLDialogElement !== 'function') {
      if (window.confirm(opcoes.pergunta)) form.submit();
      return;
    }
    if (!abrirDialogo) abrirDialogo = criarDialogo();
    abrirDialogo(opcoes, () => {
      form.dataset.confirmado = '1';
      form.requestSubmit();
    });
  });

  document.addEventListener('click', (e) => {
    const botao = e.target instanceof Element ? e.target.closest('[data-fechar-recado]') : null;
    if (botao) botao.closest('[data-recado]').remove();
  });
})();
