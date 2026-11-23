-- No "Preparar item" do workflow "RAG - Reindexar item" do n8n
WITH marcado AS (
    UPDATE itens_base_conhecimento
       SET status_indexacao = 'pendente', atualizado_em = now()
     WHERE id = $1
    RETURNING id, conteudo
),
apagados AS (
    DELETE FROM trechos_embeddings
     WHERE item_id IN (SELECT id FROM marcado)
    RETURNING id
)
SELECT id AS item_id, conteudo
FROM marcado;
