// Formatação de datas/horas no fuso de São Paulo
const FUSO = 'America/Sao_Paulo';

let formatador = null;
try {
  formatador = new Intl.DateTimeFormat('en-GB', {
    timeZone: FUSO,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
} catch (err) {
  // UTC-3
  console.warn(`AVISO: fuso ${FUSO} indisponível neste Node (${err.message}). Usando UTC-3 fixo.`);
}

const doisDigitos = (n) => String(n).padStart(2, '0');

function extrairPartes(valor) {
  if (!valor) return null;
  const data = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(data.getTime())) return null;

  if (!formatador) {
    const local = new Date(data.getTime() - 3 * 60 * 60 * 1000); // desloca 3h e lê como se fosse UTC
    return {
      day: doisDigitos(local.getUTCDate()),
      month: doisDigitos(local.getUTCMonth() + 1),
      hour: doisDigitos(local.getUTCHours()),
      minute: doisDigitos(local.getUTCMinutes()),
      second: doisDigitos(local.getUTCSeconds()),
    };
  }

  const partes = {};
  for (const p of formatador.formatToParts(data)) partes[p.type] = p.value;
  if (partes.hour === '24') partes.hour = '00'; // alguns ambientes devolvem 24 à meia-noite
  return partes;
}

// "26/10 02:22" — usado na coluna "Última atividade"
function formatarDataHora(valor) {
  const p = extrairPartes(valor);
  return p ? `${p.day}/${p.month} ${p.hour}:${p.minute}` : '—';
}

// "02:22" — usado ao lado de cada mensagem
function formatarHora(valor) {
  const p = extrairPartes(valor);
  return p ? `${p.hour}:${p.minute}` : '';
}

// "02:22:10" — usado no "última atualização às ..."
function formatarHoraCompleta(valor) {
  const p = extrairPartes(valor);
  return p ? `${p.hour}:${p.minute}:${p.second}` : '';
}

// "há quanto tempo" — usado na fila ("aguardando há 7 min"): "menos de 1 min", "7 min", "2 h 05 min", "3 d 4 h"
function tempoDecorrido(desde, agora = new Date()) {
  if (!desde) return '';
  const inicio = desde instanceof Date ? desde : new Date(desde);
  if (Number.isNaN(inicio.getTime())) return '';
  const minutos = Math.max(0, Math.floor((agora.getTime() - inicio.getTime()) / 60000)); // relógio adiantado → 0, nunca negativo
  if (minutos < 1) return 'menos de 1 min';
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `${horas} h ${doisDigitos(minutos % 60)} min`;
  return `${Math.floor(horas / 24)} d ${horas % 24} h`;
}

module.exports = { formatarDataHora, formatarHora, formatarHoraCompleta, tempoDecorrido };
