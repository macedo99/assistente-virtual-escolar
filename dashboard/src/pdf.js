// Importação de PDF para a base de conhecimento: extrai o texto de um PDF enviado pelo administrador.
//
// O texto extraído NÃO é salvo direto: ele preenche o formulário de "Novo item" para alguém revisar antes
// de salvar (e só então indexar). PDF é um formato visual — a extração pode trazer quebras de linha no meio
// das frases, cabeçalhos e rodapés repetidos ou tabelas desalinhadas, e o bot vai citar este texto.

const { PDFParse } = require('pdf-parse');

const TAMANHO_MAXIMO_BYTES = 10 * 1024 * 1024; // 10 MB
const PAGINAS_MAXIMAS = 200;

class ErroPdf extends Error {
  constructor(mensagem, codigo) {
    super(mensagem);
    this.name = 'ErroPdf';
    this.codigo = codigo; // 'formato' | 'vazio' | 'protegido' | 'paginas' | 'leitura'
  }
}

// Todo PDF começa com "%PDF-". Conferir os bytes (e não só a extensão ou o tipo que o navegador informou)
// evita mandar qualquer arquivo para o leitor de PDF.
function pareceArquivoPdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

// Deixa o texto extraído mais próximo de um texto corrido:
//  - remove os marcadores de página que o leitor insere ("-- 1 of 3 --");
//  - junta palavras hifenizadas na quebra de linha ("matrí-\ncula" → "matrícula");
//  - junta linhas quebradas no meio de uma frase (a linha seguinte começa com minúscula);
//  - tira espaços sobrando e deixa no máximo uma linha em branco entre parágrafos.
function limparTexto(bruto) {
  return String(bruto || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gim, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
    .replace(/([^\n.!?:;])\n(?=\p{Ll})/gu, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Título sugerido a partir do nome do arquivo: "Manual_do-Professor 2026.pdf" → "Manual do Professor 2026".
function tituloDoArquivo(nomeOriginal, limite) {
  const semExtensao = String(nomeOriginal || '').replace(/\.pdf$/i, '');
  return semExtensao.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limite);
}

async function extrairTexto(buffer) {
  if (!pareceArquivoPdf(buffer)) {
    throw new ErroPdf('O arquivo enviado não é um PDF válido.', 'formato');
  }

  const leitor = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    let resultado;
    try {
      resultado = await leitor.getText();
    } catch (err) {
      if (err && /password/i.test(String(err.name) + String(err.message))) {
        throw new ErroPdf('O PDF está protegido por senha. Remova a proteção e envie de novo.', 'protegido');
      }
      throw new ErroPdf('Não consegui ler este PDF (ele pode estar corrompido).', 'leitura');
    }

    const paginas = Number(resultado.total) || 0;
    if (paginas > PAGINAS_MAXIMAS) {
      throw new ErroPdf(`O PDF tem ${paginas} páginas; o limite é ${PAGINAS_MAXIMAS}. Divida o documento em partes menores.`, 'paginas');
    }

    const texto = limparTexto(resultado.text);
    if (!texto) {
      throw new ErroPdf('Não encontrei texto neste PDF. Ele provavelmente é uma imagem escaneada — esse tipo de arquivo ainda não é suportado.', 'vazio');
    }
    return { texto, paginas };
  } finally {
    await leitor.destroy().catch(() => {});
  }
}

module.exports = { ErroPdf, TAMANHO_MAXIMO_BYTES, PAGINAS_MAXIMAS, pareceArquivoPdf, limparTexto, tituloDoArquivo, extrairTexto };
