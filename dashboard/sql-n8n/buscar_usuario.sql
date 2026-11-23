-- No de "Buscar usuario" do n8n
WITH u AS (
    SELECT id, papel
    FROM usuarios
    WHERE telegram_chat_id = $1
),
ativa AS (
    SELECT c.id, c.status
    FROM conversas c
    WHERE c.usuario_id = (SELECT id FROM u)
      AND c.status <> 'encerrada'
    ORDER BY c.iniciada_em DESC
    LIMIT 1
),
nova AS (
    INSERT INTO conversas (usuario_id, status)
    SELECT u.id, 'bot'
    FROM u
    WHERE NOT EXISTS (SELECT 1 FROM ativa)
    RETURNING id, status
)
SELECT u.id AS usuario_id,
       u.papel,
       COALESCE(a.id, n.id) AS conversa_id,
       COALESCE(a.status, n.status) AS conversa_status
FROM u
LEFT JOIN ativa a ON true
LEFT JOIN nova n ON true;
