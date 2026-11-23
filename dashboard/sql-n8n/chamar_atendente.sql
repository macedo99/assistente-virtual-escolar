-- Nos "Atualizar status" (comando /humano) e "Atualizar status (botao)" do n8n
WITH atualizada AS (
    UPDATE conversas
       SET status = 'aguardando_atendente'
     WHERE usuario_id = $1
       AND status = 'bot'
    RETURNING id
)
INSERT INTO conversas (usuario_id, status)
SELECT $1::bigint, 'aguardando_atendente'
WHERE NOT EXISTS (
    SELECT 1 FROM conversas
    WHERE usuario_id = $1
      AND status <> 'encerrada'
);
